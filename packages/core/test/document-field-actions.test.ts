import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDocumentFieldAction } from "../src/document-field-actions.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { VersionConflict } from "../src/versioning.js";
import type { Bundle, OkfDocument, WriteOptions, Version } from "../src/types.js";
const registry = { kinds: new Map(), warnings: [] };
const context = { registry, okfVersion: "0.2" as const };
const doc = (fm: Record<string, unknown> = {}): OkfDocument => ({ id: "a", frontmatter: { type: "Note", title: "A", ...fm }, body: "body" });
const apply = (fm: Record<string, unknown>, action: any) => prepareDocumentFieldAction(doc(fm), action, context);

test("tag membership is exact, stable, idempotent and absent-aware", () => {
  assert.deepEqual(apply({}, { action: "add", field: "tags", value: "A" }).candidate.frontmatter.tags, ["A"]);
  assert.equal(apply({ tags: ["a", "A", "a"] }, { action: "add", field: "tags", value: "a" }).scope.outcome, "unchanged");
  assert.deepEqual(apply({ tags: ["a", "A", "a"] }, { action: "remove", field: "tags", value: "a" }).candidate.frontmatter.tags, ["A"]);
  assert.throws(() => apply({ tags: "bad" }, { action: "add", field: "tags", value: "a" }), /list/);
  assert.throws(() => apply({}, { action: "add", field: "extra", value: "a" }), /tags.*sources/);
});

test("source identity, selection, equality and property preservation", () => {
  const source = { id: "s", resource: "url", extra: { list: [1, 2] }, title: "old" };
  assert.equal(apply({ sources: [source] }, { action: "add", field: "sources", value: { title: "old", ...source } }).scope.outcome, "unchanged");
  assert.throws(() => apply({ sources: [source] }, { action: "add", field: "sources", value: { ...source, title: "new" } }), /conflict/i);
  assert.throws(() => apply({ sources: [source] }, { action: "remove", field: "sources", selector: { resource: "url" } }), /--id/);
  assert.throws(() => apply({ sources: [source, source] }, { action: "remove", field: "sources", selector: { id: "s" } }), /ambiguous/i);
  const edited = apply({ sources: [source, { resource: "other" }] }, { action: "edit", field: "sources", selector: { id: "s" }, patch: { title: "new" } });
  assert.deepEqual(edited.candidate.frontmatter.sources, [{ ...source, title: "new" }, { resource: "other" }]);
  assert.throws(() => apply({ sources: [source] }, { action: "edit", field: "sources", selector: { id: "s" }, patch: { id: "new" } }), /ID/);
  assert.throws(() => apply({ sources: [source] }, { action: "edit", field: "sources", selector: { id: "s" }, patch: { extra: "gone" } }), /list/);
  assert.throws(() => apply({ sources: [source] }, { action: "edit", field: "sources", selector: { id: "s" }, patch: { extra: source.extra } }), /list/);
});

test("ID-less additions and first-ID edits retain exact resources and detect collisions", () => {
  assert.deepEqual(apply({ sources: [{ resource: "url", title: "a" }] }, { action: "add", field: "sources", value: { resource: "url", title: "b" } }).candidate.frontmatter.sources, [{ resource: "url", title: "a" }, { resource: "url", title: "b" }]);
  assert.deepEqual(apply({ sources: [{ resource: "url" }] }, { action: "edit", field: "sources", selector: { resource: "url" }, patch: { id: "new" } }).candidate.frontmatter.sources, [{ resource: "url", id: "new" }]);
  assert.throws(() => apply({ sources: [{ resource: "url" }, { resource: "other", id: "s" }] }, { action: "edit", field: "sources", selector: { resource: "url" }, patch: { id: "s" } }), /ID/);
  assert.throws(() => apply({ sources: [{ resource: "url" }, { resource: "url", id: "s" }] }, { action: "remove", field: "sources", selector: { resource: "url" } }), /ambiguous/i);
  assert.throws(() => apply({ sources: [{ resource: "url", id: "" }] }, { action: "edit", field: "sources", selector: { resource: "url" }, patch: { id: "new" } }), /--id/);
});

class RaceBackend extends MemoryBackend {
  race?: OkfDocument;
  override async write(id: string, next: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.race) { const other = this.race; this.race = undefined; await super.write(id, other, options); }
    return super.write(id, next, options);
  }
}
async function setup(fm: Record<string, unknown> = {}) {
  const backend = new RaceBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  const bundle: Bundle = { root: "/unused", backend };
  const written = await writeDocVersioned(bundle, doc(fm));
  const base = { bundle, id: "a", mode: "patch" as const, registry, strict: false };
  return { backend, bundle, written, base };
}

test("membership retries on fresh state; scope comes from the winning attempt; stale noops refuse", async () => {
  const { backend, bundle, written, base } = await setup({ tags: ["base"] });
  backend.race = doc({ tags: ["base", "other"] });
  const result = await mutateDocument({ ...base, input: { kind: "field-action", action: { action: "add", field: "tags", value: "mine" } } });
  assert.deepEqual(result.doc.frontmatter.tags, ["base", "other", "mine"]);
  assert.equal(result.scope?.outcome, "added");
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-action", action: { action: "add", field: "tags", value: "mine" } } }), VersionConflict);
  backend.race = doc({ tags: ["base", "other", "mine", "raced"] });
  const noop = await mutateDocument({ ...base, input: { kind: "field-action", action: { action: "add", field: "tags", value: "raced" } } });
  assert.equal(noop.changed, false); assert.equal(noop.scope?.outcome, "unchanged");
  assert.deepEqual((await readDocVersioned(bundle, "a")).doc.frontmatter.tags, ["base", "other", "mine", "raced"]);
});

test("semantic assignments inspect equal input and old subtrees; raw patches inspect changed subtrees only", async () => {
  const { base } = await setup({ tags: ["a"], extra: { list: [1] }, verified: { by: "human:a" } });
  for (const assignments of [{ tags: ["a"] }, { extra: "gone" }, { verified: { by: "human:a" } }]) {
    await assert.rejects(() => mutateDocument({ ...base, input: { kind: "assign", assignments } }), /collection|list|managed/i);
  }
  await assert.rejects(() => mutateDocument({ ...base, buildCandidate: e => ({ frontmatter: { ...e!.frontmatter, extra: "gone" }, body: e!.body }) }), /list/);
  const result = await mutateDocument({ ...base, input: { kind: "assign", assignments: { title: "new" } } });
  assert.deepEqual(result.doc.frontmatter.extra, { list: [1] });
  assert.deepEqual(result.doc.frontmatter.verified, { by: "human:a" });
  const verified = await mutateDocument({ ...base, input: { kind: "verify", event: { by: "human:b", at: "2026-09-09T00:00:00Z" } } });
  assert.deepEqual(verified.doc.frontmatter.verified, [{ by: "human:a" }, { by: "human:b", at: "2026-09-09T00:00:00Z" }]);
});

test("edit and replace-all require exact versions while complete document authoring stays explicit", async () => {
  const { base, written } = await setup({ tags: "bad" });
  const input = { kind: "field-action" as const, action: { action: "replace-all" as const, field: "tags" as const, value: [] } };
  await assert.rejects(() => mutateDocument({ ...base, input }), /expectedVersion/);
  const result = await mutateDocument({ ...base, expectedVersion: written.version, input });
  assert.deepEqual(result.doc.frontmatter.tags, []);
  const replaced = await mutateDocument({ ...base, mode: "replace-document", buildCandidate: () => ({ frontmatter: doc({ tags: ["x"] }).frontmatter, body: "full" }) });
  assert.deepEqual(replaced.doc.frontmatter.tags, ["x"]);
});

test("finite set resolves Kind progress, replaces list-free mappings and protects managed fields", () => {
  const kind = { id: "conventions/task", title: "Task", governs: "Task", fields: { required: ["title"], optional: ["status", "config", "stale_after"], values: {}, terminal: {}, descriptions: {} } };
  const registry = { kinds: new Map([["Task", kind]]), warnings: [] };
  const existing = { ...doc({ config: { a: 1, b: 2 }, status: "todo" }), frontmatter: { ...doc({ config: { a: 1, b: 2 }, status: "todo" }).frontmatter, type: "Task" } };
  const context = { registry, okfVersion: "0.1" as const, now: () => "2026-09-09T12:00:00Z" };
  const progress = prepareDocumentFieldAction(existing, { action: "set", field: "progress_status", value: "done" }, context);
  assert.equal(progress.storageField, "status"); assert.equal(progress.candidate.frontmatter.status, "done");
  assert.equal(progress.candidate.frontmatter.timestamp, "2026-09-09T12:00:00Z");
  assert.deepEqual(prepareDocumentFieldAction(existing, { action: "set", field: "config", value: { a: 3 } }, context).candidate.frontmatter.config, { a: 3 });
  assert.throws(() => prepareDocumentFieldAction(existing, { action: "set", field: "stale_after", value: "x" }, context), /v0.2/);
  assert.throws(() => apply({}, { action: "set", field: "undeclared", value: "x" }), /Unsupported/);
  for (const field of ["verified", "generated", "actor", "timestamp", "superbee_updated_by"]) assert.throws(() => apply({}, { action: "set", field, value: undefined }), /managed/);
});

test("selected edit and full replacement reject stale versions without losing the concurrent row", async () => {
  const { base, backend, bundle, written } = await setup({ sources: [{ resource: "url" }] });
  backend.race = doc({ sources: [{ resource: "url" }, { resource: "other" }] });
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-action", action: { action: "edit", field: "sources", selector: { resource: "url" }, patch: { id: "first" } } } }), VersionConflict);
  const current = await readDocVersioned(bundle, "a");
  assert.deepEqual(current.doc.frontmatter.sources, [{ resource: "url" }, { resource: "other" }]);
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-action", action: { action: "replace-all", field: "sources", value: [] } } }), VersionConflict);
});

test("source removal misses preserve absence and replacement permits deliberate duplicate IDs", async () => {
  const { base, written } = await setup();
  const noop = await mutateDocument({ ...base, input: { kind: "field-action", action: { action: "remove", field: "sources", selector: { id: "missing" } } } });
  assert.equal(noop.changed, false); assert.equal(noop.version, written.version); assert.equal(noop.doc.frontmatter.sources, undefined);
  const row = { id: "duplicate", resource: "url" };
  const result = await mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-action", action: { action: "replace-all", field: "sources", value: [row, row] } } });
  assert.deepEqual(result.doc.frontmatter.sources, [row, row]);
});


test("source addition retains the standard string-ID contract, including an explicit empty ID", () => {
  const row = { id: "", resource: "url" };
  assert.deepEqual(apply({}, { action: "add", field: "sources", value: row }).candidate.frontmatter.sources, [row]);
  assert.equal(apply({ sources: [row] }, { action: "add", field: "sources", value: row }).scope.outcome, "unchanged");
  assert.throws(() => apply({ sources: [row] }, { action: "add", field: "sources", value: { ...row, resource: "other" } }), /conflict/i);
  assert.equal(apply({ sources: [row] }, { action: "remove", field: "sources", selector: { id: "" } }).scope.outcome, "removed");
  assert.throws(() => apply({ sources: [{ resource: "url" }] }, { action: "edit", field: "sources", selector: { resource: "url" }, patch: { id: "" } }), /nonempty/);
});
