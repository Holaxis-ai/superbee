import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemBackend } from "../src/backend.js";
import { prepareDocumentFieldAction, type FieldAction } from "../src/document-field-actions.js";
import { mutateDocument, prepareDocumentMutationCandidate } from "../src/document-mutation.js";
import { applyV02MutationMetadata } from "../src/document-write-policy.js";
import { OkfActorError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { KindRegistry } from "../src/kinds.js";
import type { StorageBackend } from "../src/types.js";

const FIRST = "2026-09-09T10:00:00.000Z";
const NEXT = "2026-09-09T11:00:00.000Z";

// Field previews and commits share the producer contract, including idempotent retries.
const fieldActions: FieldAction[] = [
  { action: "set", field: "title", value: "changed" },
  { action: "add", field: "tags", value: "new" },
  { action: "remove", field: "tags", value: "old" },
  { action: "edit", field: "sources", selector: { id: "source" }, patch: { title: "changed" } },
  { action: "replace-all", field: "sources", value: [{ id: "replacement", resource: "next" }] },
  { action: "upsert", field: "sources", value: { id: "source", resource: "original", title: "changed" } },
];
for (const action of fieldActions) {
  test(`${action.action}: field preview and commit preserve separate producer and history actor`, async () => {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    const registry: KindRegistry = { kinds: new Map(), warnings: [] };
    const common = { bundle: { root: "/unused", backend }, id: "notes/test", registry, strict: true };
    const created = await mutateDocument({ ...common, mode: "create-only", now: () => FIRST,
      buildCandidate: () => ({ frontmatter: { type: "Note", title: "old", tags: ["old"],
        sources: [{ id: "source", resource: "original" }] }, body: "untouched body" }) });
    const attribution = { actor: "person:authenticated", producer: "process:field-writer" };
    const previewOptions = { ...attribution, id: common.id, registry, strict: true,
      okfVersion: "0.2" as const, now: () => NEXT };
    const raw = prepareDocumentFieldAction(created.doc, action, previewOptions);
    const preview = prepareDocumentMutationCandidate(created.doc, raw.candidate, previewOptions);
    const committed = await mutateDocument({ ...common, ...attribution, mode: "patch", now: () => NEXT,
      expectedVersion: created.version, input: { kind: "field-action", action } });
    assert.equal(preview.changed, true);
    assert.equal(committed.changed, true);
    assert.deepEqual(committed.doc.frontmatter, preview.candidate.frontmatter);
    assert.equal(committed.doc.body, "untouched body\n");
    assert.deepEqual(committed.doc.frontmatter.generated, { by: attribution.producer, at: NEXT });
    assert.equal(committed.doc.frontmatter.superbee_updated_by, attribution.actor);
    assert.equal((await backend.versions(common.id)).find(row => row.version === committed.version)?.actor, attribution.actor);

    const noopAttribution = { actor: "person:other", producer: "process:other-writer" };
    const noopRaw = prepareDocumentFieldAction(committed.doc, action, previewOptions);
    const noopPreview = prepareDocumentMutationCandidate(committed.doc, noopRaw.candidate,
      { ...previewOptions, ...noopAttribution });
    const noop = await mutateDocument({ ...common, ...noopAttribution, mode: "patch", now: () => NEXT,
      expectedVersion: committed.version, input: { kind: "field-action", action } });
    assert.equal(noopPreview.changed, false);
    assert.equal(noop.changed, false);
    assert.deepEqual(noop.doc.frontmatter, noopPreview.candidate.frontmatter);
    assert.equal(noop.version, committed.version);
    assert.equal((await backend.versions(common.id)).length, 2);

    assert.throws(() => prepareDocumentMutationCandidate(committed.doc, noopRaw.candidate,
      { ...previewOptions, producer: "invalid" }), OkfActorError);
    await assert.rejects(mutateDocument({ ...common, ...attribution, producer: "invalid", mode: "patch",
      expectedVersion: committed.version, input: { kind: "field-action", action } }), OkfActorError);
    assert.equal((await backend.read(common.id)).version, committed.version);
  });
}

// One matrix projects producer/advisory separation through every mutation mode,
// edition, backend and automatic Kind attribution path with the public default.
for (const storage of ["memory", "filesystem"] as const) {
  for (const edition of ["0.1", "0.2"] as const) {
    for (const requiredActor of [false, true]) {
      for (const mode of ["create-only", "patch", "overwrite", "replace-document"] as const) {
        test(`${storage} ${edition} ${mode} required actor=${requiredActor}: default persistence keeps producer and attribution independent`, async (t) => {
          const root = storage === "filesystem" ? await mkdtemp(path.join(tmpdir(), "sb-attribution-")) : "/unused";
          if (storage === "filesystem") t.after(() => rm(root, { recursive: true, force: true }));
          const backend: StorageBackend = storage === "filesystem" ? new FilesystemBackend(root) : new MemoryBackend();
          await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
          const bundle = { root, backend };
          const registry: KindRegistry = {
            warnings: [],
            kinds: requiredActor ? new Map([["Note", {
              id: "conventions/note", title: "Note", governs: "Note",
              fields: { required: ["actor"], optional: [], values: {}, terminal: {}, descriptions: {} },
            }]]) : new Map(),
          };
          const common = {
            bundle, id: "notes/test", registry, strict: true,
            actor: "person:authenticated", producer: "process:hosted-writer",
          };
          const created = await mutateDocument({
            ...common, mode, onAbsent: "create", now: () => FIRST,
            buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "one" }),
          });
          const attribution = edition === "0.1" ? "actor" : "superbee_updated_by";
          assert.equal(created.doc.frontmatter[attribution], common.actor);
          if (requiredActor) assert.equal(created.doc.frontmatter.actor, common.actor);
          assert.deepEqual(created.doc.frontmatter.generated,
            edition === "0.2" ? { by: common.producer, at: FIRST } : undefined);
          assert.equal((await backend.versions(common.id))[0]?.actor, common.actor);

          const updateMode = mode === "create-only" ? "patch" : mode;
          const changed = await mutateDocument({
            ...common, mode: updateMode, actor: "principal:second", producer: "process:next-writer",
            now: () => NEXT,
            buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "two" }),
          });
          assert.equal(changed.changed, true);
          assert.equal(changed.doc.frontmatter[attribution], "principal:second");
          if (requiredActor) assert.equal(changed.doc.frontmatter.actor, "principal:second");
          assert.deepEqual(changed.doc.frontmatter.generated,
            edition === "0.2" ? { by: "process:next-writer", at: NEXT } : undefined);

          const noop = await mutateDocument({
            ...common, mode: updateMode, actor: "principal:third", producer: "process:third-writer",
            now: () => "2026-09-09T12:00:00.000Z",
            buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: existing!.body }),
          });
          assert.equal(noop.changed, false);
          assert.equal(noop.version, changed.version);
          assert.deepEqual(noop.doc, changed.doc);
          const history = await backend.versions(common.id);
          assert.equal(history.length, storage === "memory" ? 2 : 1);
          assert.deepEqual(new Set(history.map(row => row.actor)), new Set(storage === "memory"
            ? [common.actor, "principal:second"] : ["principal:second"]));
        });
      }
    }
  }
}

for (const edition of ["0.1", "0.2"] as const) {
  for (const persistActor of [false, undefined] as const) {
    test(`${edition} persistActor=${persistActor}: opt-out or absent actor preserves candidate attribution in previews and commits`, async () => {
      const backend = new MemoryBackend();
      await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
      const registry: KindRegistry = { kinds: new Map(), warnings: [] };
      const field = edition === "0.1" ? "actor" : "superbee_updated_by";
      const opts = { id: "notes/test", registry, strict: false, okfVersion: edition,
        actor: persistActor === false ? "human:writer" : undefined, producer: "process:producer", persistActor,
        now: () => FIRST };
      const raw = { frontmatter: { type: "Note", [field]: "human:previous" }, body: "one" };
      const preview = prepareDocumentMutationCandidate(undefined, raw, opts);
      const committed = await mutateDocument({ ...opts, bundle: { root: "/unused", backend }, mode: "create-only", buildCandidate: () => raw });
      assert.deepEqual(committed.doc.frontmatter, preview.candidate.frontmatter);
      assert.equal(committed.doc.frontmatter[field], "human:previous");
      if (persistActor === false) assert.equal((await backend.versions(opts.id))[0]?.actor, "human:writer");
      const changedRaw = { frontmatter: committed.doc.frontmatter, body: "two" };
      const changedPreview = prepareDocumentMutationCandidate(committed.doc, changedRaw, { ...opts, now: () => NEXT });
      const changed = await mutateDocument({ ...opts, bundle: { root: "/unused", backend }, mode: "patch",
        now: () => NEXT, buildCandidate: () => changedRaw });
      assert.deepEqual(changed.doc.frontmatter, changedPreview.candidate.frontmatter);
      assert.equal(changed.doc.frontmatter[field], "human:previous");
    });
  }
}

for (const edition of ["0.1", "0.2"] as const) {
  for (const mode of ["patch", "overwrite", "replace-document"] as const) {
    test(`${edition} ${mode}: supplying an actor does not claim an unchanged legacy document`, async () => {
      const backend = new MemoryBackend();
      await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
      const bundle = { root: "/unused", backend };
      const original = { id: "notes/legacy", frontmatter: { type: "Note", title: "Legacy", timestamp: FIRST }, body: "unchanged\n" };
      const version = await backend.write(original.id, original);
      const registry: KindRegistry = { kinds: new Map(), warnings: [] };
      const opts = { id: original.id, registry, strict: false, actor: "human:new-writer", producer: "process:new-producer", now: () => NEXT };
      const raw = { frontmatter: { ...original.frontmatter }, body: original.body };
      const preview = prepareDocumentMutationCandidate(original, raw, { ...opts, okfVersion: edition });
      const result = await mutateDocument({ ...opts, bundle, mode, buildCandidate: () => raw });
      assert.equal(preview.changed, false);
      assert.equal(result.changed, false);
      assert.equal(result.version, version);
      assert.deepEqual(result.doc, original);
      assert.deepEqual(preview.candidate, raw);
      assert.equal((await backend.versions(original.id)).length, 1);
    });
  }
}

const rows = [
  { actor: undefined, producer: undefined, expected: "process:superbee" },
  { actor: "human:alice", producer: undefined, expected: "human:alice" },
  { actor: "person:opaque", producer: "process:writer", expected: "process:writer" },
  { actor: undefined, producer: "process:writer", expected: "process:writer" },
  { actor: "person:opaque", producer: undefined, expected: null },
  ...["", " ", "bad actor", "person:opaque", null].map(producer => ({ actor: "human:alice", producer, expected: null })),
];
for (const [index, row] of rows.entries()) {
  test(`metadata producer resolution row ${index} agrees with mutation admission`, async () => {
    const candidate = { frontmatter: { type: "Note" }, body: "body" };
    // Deliberately exercise malformed JavaScript callers as well as typed input.
    const supplied = { actor: row.actor, producer: row.producer as string | undefined };
    const apply = () => applyV02MutationMetadata({ ...supplied, candidate, meaningfulChangeAt: FIRST, requireGenerationClock: true });
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    const mutate = () => mutateDocument({ ...supplied, bundle: { root: "/unused", backend }, id: "notes/test",
      registry: { kinds: new Map(), warnings: [] }, strict: true, mode: "create-only", now: () => FIRST, buildCandidate: () => candidate });
    if (row.expected === null) {
      assert.throws(apply, OkfActorError);
      await assert.rejects(mutate, OkfActorError);
      assert.deepEqual(await backend.list(), []);
    } else {
      assert.deepEqual(apply().frontmatter.generated, { by: row.expected, at: FIRST });
      assert.deepEqual((await mutate()).doc.frontmatter.generated, { by: row.expected, at: FIRST });
    }
  });
}

test("v0.1 ignores producer without changing advisory attribution", async () => {
  const backend = new MemoryBackend();
  const result = await mutateDocument({ bundle: { root: "/unused", backend }, id: "notes/test",
    registry: { kinds: new Map(), warnings: [] }, strict: true, mode: "create-only", actor: "legacy actor",
    producer: "", persistActor: true, now: () => FIRST,
    buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body" }) });
  assert.equal(result.doc.frontmatter.actor, "legacy actor");
  assert.equal(result.doc.frontmatter.generated, undefined);
  assert.equal((await backend.versions("notes/test"))[0]?.actor, "legacy actor");
});

test("producer is an API option, not a candidate field or validation bypass", async () => {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const common = { bundle: { root: "/unused", backend }, id: "notes/test",
    registry: { kinds: new Map(), warnings: [] }, strict: true, actor: "person:opaque", now: () => FIRST };
  await assert.rejects(mutateDocument({ ...common, mode: "create-only",
    buildCandidate: () => ({ frontmatter: { type: "Note", producer: "process:forged" }, body: "body" }) }), OkfActorError);
  const created = await mutateDocument({ ...common, mode: "create-only", producer: "process:writer",
    buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body" }) });
  await assert.rejects(mutateDocument({ ...common, mode: "patch", producer: "",
    buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: existing!.body }) }), OkfActorError);
  await assert.rejects(mutateDocument({ ...common, mode: "patch", producer: "process:writer",
    buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, generated: { by: "invalid actor" } }, body: "changed" }) }));
  assert.equal((await backend.read(common.id)).version, created.version);
  assert.equal((await backend.versions(common.id)).length, 1);
});
