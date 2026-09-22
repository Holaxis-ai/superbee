import assert from "node:assert/strict";

/** Identical vectors run against each host's parser, preparation policy, and installed core. */
export async function runViewActionConformance(vector, edition, fixture, api) {
  const { MemoryBackend, writeDoc, loadKinds, parseActionBridgeMessage, prepareViewDocumentAction } = api;
  const backend = new MemoryBackend();
  const bundle = { root: "mem://view-action-conformance", backend };
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition === "0.3" ? "0.2" : edition}'\n---\n`);
  const kind = structuredClone(fixture.kind);
  kind.frontmatter.fields.optional = kind.frontmatter.fields.optional.map(field => field === "progress_status" ? (edition === "0.1" ? "status" : "superbee_progress_status") : field);
  if (!vector.omitKind) await writeDoc(bundle, kind);
  const document = structuredClone(fixture.document);
  Object.assign(document.frontmatter, vector.existingFields ?? {});
  const action = structuredClone(vector.action);
  if (vector.expand) {
    const { target, text, count } = vector.expand;
    const paths = target.split(".");
    let object = { action, document };
    for (const part of paths.slice(0, -1)) object = object[part];
    object[paths.at(-1)] = text.repeat(count);
  }
  const parsed = parseActionBridgeMessage({ bridge: "v1", type: "action.propose", requestId: "sample", action });
  assert.equal(parsed?.ok, vector.parseAccept ?? true, "grammar verdict");
  const context = { registry: await loadKinds(bundle), okfVersion: edition, actor: vector.actor ?? fixture.actor, producer: vector.producer, timestamp: fixture.timestamp };
  const prepare = () => prepareViewDocumentAction(document, action, context);
  if (!vector.accept) {
    assert.throws(prepare);
    return;
  }
  const before = structuredClone(document);
  const prepared = prepare();
  assert.deepEqual(document, before, "preparation does not mutate input");
  assert.equal(prepared.changed, true);
  assert.equal(prepared.action.docId, document.id);
  for (const [field, value] of Object.entries(vector.expectedFields ?? {})) {
    const stored = field === "progress_status" ? (edition === "0.2" ? "superbee_progress_status" : "status") : field;
    assert.equal(prepared.candidate.frontmatter[stored], value);
  }
  const body = action.kind === "document.set-body" ? action.value : action.kind === "document.update" ? action.value.body : document.body;
  assert.equal(prepared.candidate.body, body);
  assert.equal(prepared.candidate.frontmatter[edition === "0.1" ? "actor" : "superbee_updated_by"], context.actor);
  if (vector.producer && edition === "0.2") assert.equal(prepared.candidate.frontmatter.generated.by, vector.producer);
  if (action.kind === "document.update") {
    assert.deepEqual(JSON.parse(prepared.after), action.value);
    assert.deepEqual(JSON.parse(prepared.before).body, document.body);
  }
}
