import assert from "node:assert/strict";
import test from "node:test";
import { isOkfRecord, okfValuesEqual } from "../src/okf-authored-values.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import type { Frontmatter } from "../src/types.js";

const NOW = "2026-09-09T12:00:00Z";
const registry = { kinds: new Map(), warnings: [] };
const fm = (value: Record<string, unknown>): Frontmatter => ({ type: "Note", ...value }) as Frontmatter;
async function harness(edition = "0.2") {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  return { root: "mem://standard-fields", backend };
}
const invalid: Array<[string, Record<string, unknown>]> = [
  ["title", { title: 1 }], ["description", { description: [] }], ["resource", { resource: {} }],
  ["tags", { tags: "tag" }], ["tags[0]", { tags: [1] }], ["status", { status: "ready" }],
  ["sources", { sources: {} }], ["sources[0]", { sources: [null] }],
  ["sources[0].resource", { sources: [{}] }], ["sources[0].resource", { sources: [{ resource: " " }] }],
  ["sources[0].id", { sources: [{ resource: "scope", id: 1 }] }],
  ["sources[0].title", { sources: [{ resource: "scope", title: false }] }],
  ["sources[0].author", { sources: [{ resource: "scope", author: " " }] }],
  ...[-1, 0.5, Infinity, NaN, "2"].map(usage_count => ["sources[0].usage_count", { sources: [{ resource: "scope", usage_count }] }] as [string, Record<string, unknown>]),
  ["usage_window", { usage_window: [] }], ["sources[0].usage_window", { sources: [{ resource: "scope", usage_window: 1 }] }],
  ["verified", { verified: "human:me" }], ["verified[0]", { verified: [false] }],
  ["verified.by", { verified: { at: NOW } }], ["verified.by", { verified: { by: "team:docs", at: NOW } }],
  ["verified.at", { verified: { by: "human:me" } }],
  ["generated", { generated: [] }], ["generated.by", { generated: { by: null } }],
  ["runtime", { type: "Attested Computation" }], ["runtime", { type: "Attested Computation", runtime: " " }],
  ["parameters", { type: "Attested Computation", runtime: "custom", parameters: {} }],
  ["parameters[0].name", { type: "Attested Computation", runtime: "custom", parameters: [{ type: "integer" }] }],
  ["parameters[0].type", { type: "Attested Computation", runtime: "custom", parameters: [{ name: "n" }] }],
  ["parameters[0].required", { type: "Attested Computation", runtime: "custom", parameters: [{ name: "n", type: "custom", required: "yes" }] }],
  ["computation", { type: "Attested Computation", runtime: "custom", computation: [] }],
  ["executor", { type: "Attested Computation", runtime: "custom", executor: [] }],
  ["executor.resource", { type: "Attested Computation", runtime: "custom", executor: { resource: 1 } }],
  ["executor.receipt[0]", { type: "Attested Computation", runtime: "custom", executor: { receipt: [1] } }],
  ["attester.resource", { type: "Attested Computation", runtime: "custom", attester: { resource: false } }],
];

const invalidRuntimeMappings: Array<[string, Record<string, unknown>]> = [
  ["usage_window", { usage_window: new Date(NOW) }],
  ["generated", { generated: new Date(NOW) }],
  ["executor", { type: "Attested Computation", runtime: "custom", executor: new Date(NOW) }],
  ["attester", { type: "Attested Computation", runtime: "custom", attester: new Date(NOW) }],
  ["sources[0].usage_window", { sources: [{ resource: "scope", usage_window: new Date(NOW) }] }],
  ["verified", { verified: new Date(NOW) }],
  ["usage_window", { usage_window: new Map() }],
  ["usage_window", { usage_window: new Set() }],
  ["usage_window", { usage_window: /runtime-object/ }],
];

test("all creation routes refuse invalid standard fields without persistence, independently of Kind strictness", async () => {
  for (const [field, fields] of [...invalid, ...invalidRuntimeMappings]) for (const mode of ["create-only", "overwrite", "patch"] as const) for (const strict of [false, true]) {
    const bundle = await harness();
    await assert.rejects(mutateDocument({ bundle, id: "check", mode, onAbsent: "create", registry, strict, now: () => NOW, buildCandidate: () => ({ frontmatter: fm(fields), body: "x" }) }), error => error instanceof Error && error.message.includes(field), `${mode} ${field}`);
    await assert.rejects(readDocVersioned(bundle, "check"));
  }
});

test("optional families, bare verification, scope sources and unknown extensions round trip", async () => {
  const cases = [{}, { sources: [], verified: [], tags: [], usage_window: {} }, {
    resource: "all queries in project X", sources: [{ resource: "all queries in project X", author: "team:docs", id: "same", usage_count: 0, usage_window: {}, custom: { at: "yesterday" } }, { resource: "../reference.md", id: "same" }],
    verified: { by: "human:me", at: NOW, method: { custom: true } }, tags: [""], status: "draft", custom: [null],
  }, { type: "Attested Computation", runtime: "producer-runtime", parameters: [{ name: "n", type: "producer-type", custom: true }], executor: { receipt: [], extra: 3 }, attester: {}, computation: "../query.sql" },
  { type: "Producer Thing", runtime: [], parameters: false, executor: "extension", attester: 12, computation: {} }];
  for (const fields of cases) for (const mode of ["create-only", "overwrite", "patch"] as const) {
    const bundle = await harness();
    const result = await mutateDocument({ bundle, id: "check", mode, onAbsent: "create", registry, strict: false, seedGenerationClock: false, now: () => NOW, buildCandidate: () => ({ frontmatter: fm(fields), body: "x" }) });
    assert.deepEqual(result.doc.frontmatter, fm(fields));
  }
});

test("unchanged imported values survive while changed invalid values refuse", async () => {
  for (const [field, fields] of invalid.filter(([, fields]) => fields.type !== "Attested Computation" && fields.generated === undefined)) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "legacy", frontmatter: fm(fields), body: "old\n" });
    const imported = await readDocVersioned(bundle, "legacy");
    const edited = await mutateDocument({ bundle, id: "legacy", mode: "patch", registry, strict: false, seedGenerationClock: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "new\n" }) });
    for (const key of Object.keys(fields)) assert.deepEqual(edited.doc.frontmatter[key], imported.doc.frontmatter[key], field);
    assert.deepEqual((await readDocVersioned(bundle, "legacy")).doc, edited.doc);
    const before = await readDocVersioned(bundle, "legacy");
    await assert.rejects(mutateDocument({ bundle, id: "legacy", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, status: "another-invalid-status" }, body: "x" }) }), /status/);
    assert.deepEqual(await readDocVersioned(bundle, "legacy"), before);
  }
});

test("legacy rows permit reorder removal and valid additions but not duplication or editing", async () => {
  for (const key of ["sources", "verified", "parameters"] as const) {
    const bad = key === "sources" ? { resource: false, custom: 1 } : key === "verified" ? { by: "legacy", at: NOW } : { name: 1, type: "custom" };
    const good = key === "sources" ? { resource: "scope" } : key === "verified" ? { by: "human:me", at: NOW } : { name: "n", type: "custom" };
    for (const rows of [[good, bad, good], [good], [bad, bad], [{ ...bad, extra: true }]]) {
      const bundle = await harness();
      const base = key === "parameters" ? { type: "Attested Computation", runtime: "custom" } : {};
      await writeDocVersioned(bundle, { id: "legacy", frontmatter: fm({ ...base, [key]: [bad, good] }), body: "old\n" });
      const operation = mutateDocument({ bundle, id: "legacy", mode: "replace-document", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, [key]: rows }, body: "new\n" }) });
      if (rows.length === 1 && rows[0] === good || rows.length === 3) assert.deepEqual((await operation).doc.frontmatter[key], rows);
      else await assert.rejects(operation, error => error instanceof Error && error.message.includes(key));
    }
  }
});

test("retyping creates computation obligations even for unchanged producer extensions", async () => {
  for (const fields of [{}, { runtime: false }, { runtime: "custom", executor: false }]) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "retype", frontmatter: fm(fields), body: "old" });
    await assert.rejects(mutateDocument({ bundle, id: "retype", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, type: "Attested Computation" }, body: "old" }) }), /runtime|executor/);
  }
});

test("malformed imported generated containers preserve, repair and remove without spreading", async () => {
  for (const generated of [null, "legacy", 42, ["legacy"]]) for (const change of ["body", "repair", "remove"]) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "legacy", frontmatter: fm({ generated }), body: "old\n" });
    const result = await mutateDocument({ bundle, id: "legacy", mode: "replace-document", registry, strict: false, seedGenerationClock: false, now: () => NOW, buildCandidate: existing => {
      const frontmatter = { ...existing!.frontmatter };
      if (change === "remove") delete frontmatter.generated;
      if (change === "repair") frontmatter.generated = { by: "process:writer" };
      return { frontmatter, body: "new\n" };
    } });
    if (change === "body") assert.deepEqual(result.doc.frontmatter.generated, generated);
    if (change === "remove") assert.equal(Object.hasOwn(result.doc.frontmatter, "generated"), false);
    if (change === "repair") assert.deepEqual(result.doc.frontmatter.generated, { by: "process:superbee", at: NOW });
  }
});

test("v0.1 creation remains permissive", async () => {
  const bundle = await harness("0.1");
  const fields = fm({ sources: false, verified: false, status: "legacy", generated: "legacy" });
  const result = await mutateDocument({ bundle, id: "legacy", mode: "create-only", registry, strict: false, buildCandidate: () => ({ frontmatter: fields, body: "x" }) });
  for (const key of Object.keys(fields)) assert.deepEqual(result.doc.frontmatter[key], fields[key]);
});

test("a CAS retry revalidates standard values against the fresh head", async () => {
  const bundle = await harness();
  const legacy = fm({ sources: [{ resource: false }] });
  await writeDocVersioned(bundle, { id: "race", frontmatter: legacy, body: "old\n" });
  let attempts = 0;
  await assert.rejects(mutateDocument({ bundle, id: "race", mode: "replace-document", registry, strict: false, now: () => NOW, buildCandidate: async () => {
    if (++attempts === 1) await writeDocVersioned(bundle, { id: "race", frontmatter: fm({ sources: [{ resource: "repaired" }] }), body: "racer\n" });
    return { frontmatter: legacy, body: "new\n" };
  } }), /sources\[0\].resource/);
  assert.equal(attempts, 2);
  assert.equal((await readDocVersioned(bundle, "race")).doc.body, "racer\n");
});

test("generated input rejects explicit invalid actors before rewrite and preserves legacy records", async () => {
  for (const seedGenerationClock of [false, true]) for (const by of [null, "", "legacy", 1]) {
    const bundle = await harness();
    await assert.rejects(mutateDocument({ bundle, id: "new", mode: "create-only", registry, strict: false, seedGenerationClock, now: () => NOW, actor: "process:writer", buildCandidate: () => ({ frontmatter: fm({ generated: { by } }), body: "new" }) }), /generated.by/);
    await assert.rejects(readDocVersioned(bundle, "new"));
  }
  for (const generated of [{}, { by: "legacy" }, { by: null }]) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "old", frontmatter: fm({ generated }), body: "old\n" });
    const noop = await mutateDocument({ bundle, id: "old", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: existing!.body }) });
    assert.equal(noop.changed, false);
    const verify = await mutateDocument({ bundle, id: "old", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, verified: { by: "human:me", at: NOW } }, body: existing!.body }) });
    assert.deepEqual(verify.doc.frontmatter.generated, generated);
    const edited = await mutateDocument({ bundle, id: "old", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "new\n" }) });
    assert.deepEqual(edited.doc.frontmatter.generated, { by: "process:superbee", at: NOW });
  }
});

test("candidate callbacks cannot mutate the fresh-head legacy exemption basis", async () => {
  for (const mode of ["replace-document", "overwrite"] as const) {
    const bundle = await harness();
    const before = await writeDocVersioned(bundle, { id: "alias", frontmatter: fm({ sources: [{ resource: "valid" }] }), body: "old\n" });
    await assert.rejects(mutateDocument({ bundle, id: "alias", mode, registry, strict: false, now: () => NOW, buildCandidate: existing => {
      (existing!.frontmatter.sources as Array<Record<string, unknown>>)[0]!.resource = false;
      return { frontmatter: existing!.frontmatter, body: "new\n" };
    } }), /sources\[0\].resource/);
    assert.deepEqual(await readDocVersioned(bundle, "alias"), before);
  }
});

test("sparse authored lists validate missing slots instead of serializing them as null", async () => {
  for (const fields of [{ tags: new Array(1) }, { sources: new Array(1) }, { verified: new Array(1) }, { type: "Attested Computation", runtime: "custom", parameters: new Array(1) }, { type: "Attested Computation", runtime: "custom", executor: { receipt: new Array(1) } }]) {
    const bundle = await harness();
    await assert.rejects(mutateDocument({ bundle, id: "sparse", mode: "create-only", registry, strict: false, now: () => NOW, buildCandidate: () => ({ frontmatter: fm(fields), body: "x" }) }), /\[0\]/);
    await assert.rejects(readDocVersioned(bundle, "sparse"));
  }
});


test("runtime objects cannot borrow legacy exemptions from empty mappings", async () => {
  for (const value of [new Date(NOW), new Map(), new Set(), /runtime-object/]) {
    assert.equal(isOkfRecord(value), false);
    assert.equal(okfValuesEqual(value, {}), false);
    assert.equal(okfValuesEqual({}, value), false);
    const bundle = await harness();
    const before = await writeDocVersioned(bundle, { id: "legacy", frontmatter: fm({ usage_window: {} }), body: "old\n" });
    await assert.rejects(mutateDocument({ bundle, id: "legacy", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, usage_window: value }, body: "new\n" }) }), /usage_window/);
    assert.deepEqual(await readDocVersioned(bundle, "legacy"), before);
  }
});

test("ordinary and null-prototype mappings work while producer Date values remain accepted", async () => {
  const bare = Object.assign(Object.create(null), { from: NOW });
  assert.equal(isOkfRecord(bare), true);
  assert.equal(okfValuesEqual(bare, { from: NOW }), true);
  const bundle = await harness();
  const result = await mutateDocument({ bundle, id: "mappings", mode: "create-only", registry, strict: false, now: () => NOW, buildCandidate: () => ({ frontmatter: fm({ usage_window: bare, sources: [{ resource: "scope", custom: new Date(NOW) }], producer: new Date(NOW) }), body: "x" }) });
  assert.equal((result.doc.frontmatter.usage_window as Record<string, unknown>).from, NOW);
  assert.deepEqual(result.doc.frontmatter.producer, new Date(NOW));
  assert.deepEqual((result.doc.frontmatter.sources as Array<Record<string, unknown>>)[0]!.custom, new Date(NOW));
  const noop = await mutateDocument({ bundle, id: "mappings", mode: "patch", registry, strict: false, now: () => "2026-09-10T12:00:00Z", buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: existing!.body }) });
  assert.equal(noop.changed, false);
  assert.equal(okfValuesEqual(new Date(NOW), new Date(NOW)), true);
});
