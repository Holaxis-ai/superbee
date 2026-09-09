import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDocumentFieldAction, type FieldAction } from "../src/document-field-actions.js";
import { mutateDocument, prepareDocumentMutationCandidate } from "../src/document-mutation.js";
import { applyV02MutationMetadata } from "../src/document-write-policy.js";
import { OkfActorError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { KindRegistry } from "../src/kinds.js";

const FIRST = "2026-09-09T10:00:00.000Z";
const NEXT = "2026-09-09T11:00:00.000Z";

// Field previews and commits share the producer contract, including idempotent retries.
const fieldActions: FieldAction[] = [
  { action: "set", field: "title", value: "changed" },
  { action: "add", field: "tags", value: "new" },
  { action: "remove", field: "tags", value: "old" },
  { action: "edit", field: "sources", selector: { id: "source" }, patch: { title: "changed" } },
  { action: "replace-all", field: "sources", value: [{ id: "replacement", resource: "next" }] },
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
    const attribution = { actor: "person:authenticated", producer: "process:field-writer", persistActor: true };
    const previewOptions = { ...attribution, id: common.id, registry, strict: true,
      okfVersion: "0.2" as const, now: () => NEXT };
    const raw = prepareDocumentFieldAction(created.doc, action, previewOptions);
    const preview = prepareDocumentMutationCandidate(created.doc, raw.candidate, previewOptions);
    const committed = await mutateDocument({ ...common, ...attribution, mode: "patch", now: () => NEXT,
      expectedVersion: created.version, input: { kind: "field-action", action } });
    assert.equal(preview.changed, true);
    assert.equal(committed.changed, true);
    assert.deepEqual(committed.doc.frontmatter, preview.candidate.frontmatter);
    assert.equal(committed.doc.body, "untouched body");
    assert.deepEqual(committed.doc.frontmatter.generated, { by: attribution.producer, at: NEXT });
    assert.equal(committed.doc.frontmatter.superbee_updated_by, attribution.actor);
    assert.equal((await backend.versions(common.id)).find(row => row.version === committed.version)?.actor, attribution.actor);

    const noopAttribution = { actor: "person:other", producer: "process:other-writer", persistActor: true };
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
// edition and automatic Kind attribution path.
for (const edition of ["0.1", "0.2"] as const) {
  for (const requiredActor of [false, true]) {
    for (const mode of ["create-only", "patch", "overwrite"] as const) {
      test(`${edition} ${mode} required actor=${requiredActor}: producer and attribution remain independent`, async () => {
        const backend = new MemoryBackend();
        await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
        const bundle = { root: "/unused", backend };
        const registry: KindRegistry = {
          warnings: [],
          kinds: requiredActor ? new Map([["Note", {
            id: "conventions/note", title: "Note", governs: "Note",
            fields: { required: ["actor"], optional: [], values: {}, terminal: {}, descriptions: {} },
          }]]) : new Map(),
        };
        const common = {
          bundle, id: "notes/test", registry, strict: true, persistActor: true,
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
        assert.equal(history.length, 2);
        assert.deepEqual(new Set(history.map(row => row.actor)), new Set([common.actor, "principal:second"]));
      });
    }
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
