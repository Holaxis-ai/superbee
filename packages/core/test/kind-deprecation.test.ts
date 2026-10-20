import test from "node:test";
import assert from "node:assert/strict";
import { buildKindRegistry, inspectKindDeprecatedUsage, kindConventionDoc, kindDeprecationTransition, parseConventionDoc, validateAgainstKind } from "../src/kinds.js";
import { mutateDocument, KindConformanceError } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { bundleHealth } from "../src/bundle-health/index.js";
import { installRecipe, planRecipeEvolution, applyRecipeEvolution, prepareRecipeInstall, materializeRecipeForEdition } from "../src/recipe-lifecycle/index.js";
import type { LoadedRecipe } from "../src/recipes.js";
import type { Bundle, OkfDocument, WriteOptions, Version } from "../src/types.js";
import { deprecationConvention, deprecationRows, deprecationEligibilityRows, deprecationMaterializationRows, widget } from "./fixtures/kind-deprecation-rows.js";

const registry = () => buildKindRegistry([deprecationConvention], [], { okfVersion: "0.2" });
async function memory(backend = new MemoryBackend()): Promise<Bundle & { backend: MemoryBackend }> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  return { root: "mem://deprecation", backend };
}

test("deprecation agreement rows: pure owner and lenient/strict mutation postures", async t => {
  for (const row of deprecationRows) await t.test(row.name, async () => {
    const input = structuredClone(row);
    assert.equal(kindDeprecationTransition(row.existing, row.candidate, registry()).length > 0, row.refused);
    for (const strict of [false, true]) for (const mode of row.existing ? ["patch", "replace-document", "overwrite"] as const : ["create-only", "patch", "overwrite"] as const) {
      if (mode === "patch" && row.existing && (Object.hasOwn(row.existing.frontmatter, "topics") || Object.hasOwn(row.candidate.frontmatter, "topics"))) continue; // Lists require the explicit field-action seam, exercised below.
      const bundle = await memory();
      if (row.existing) await bundle.backend.write(row.existing.id, row.existing);
      const action = mutateDocument({ bundle, id: row.candidate.id, mode, onAbsent: "create", registry: registry(), strict, bodyReplace: { replaceLinks: true },
        buildCandidate: () => ({ frontmatter: structuredClone(row.candidate.frontmatter), body: row.candidate.body }) });
      if (row.refused) await assert.rejects(action, (error: unknown) => error instanceof KindConformanceError && error.violations.some(v => v.code.startsWith("KIND_DEPRECATED")));
      else await action;
    }
    assert.deepEqual(row, input, "pure policy and mutation preparation do not mutate fixture input");
  });
});

test("read usage is informational, counts occurrences and malformed qualified references remain unknown", async () => {
  const bundle = await memory();
  await bundle.backend.write(deprecationConvention.id, deprecationConvention);
  const old = widget({ legacy: null, category: "old", topics: ["old"] }, "[legacy_link](okf://INVALID/x.md)");
  await bundle.backend.write(old.id, old);
  const kind = registry().kinds.get("Widget")!;
  assert.deepEqual(validateAgainstKind(old, kind), []);
  const rows = inspectKindDeprecatedUsage(old, kind);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(r => r.unknown).length, 1);
  const health = await bundleHealth(bundle);
  assert.equal(health.kindLint.length, 0);
  assert.equal(health.conformanceDebt?.length, 0);
  assert.equal(health.deprecatedUsage?.length, 4);
  const noop = await mutateDocument({ bundle, id: old.id, mode: "patch", registry: registry(), strict: true, buildCandidate: d => ({ frontmatter: d!.frontmatter, body: d!.body }) });
  assert.equal(noop.changed, false);
});

test("recognized invalid policies keep their Kind and refuse admitted writes, including no-op", async t => {
  const policies: unknown[] = [null, [], { bogus: [] }, { fields: ["missing"] }, { fields: ["title"] },
    { fields: ["legacy", 3] }, { values: { category: ["missing"] } }, { values: { title: ["One"] } },
    { links: ["missing"] }, { values: "bad" }];
  for (const policy of policies) await t.test(JSON.stringify(policy), async () => {
    const convention = structuredClone(deprecationConvention); convention.frontmatter.deprecated = policy;
    const reg = buildKindRegistry([convention]);
    assert.ok(reg.kinds.has("Widget"));
    assert.ok(reg.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"));
    const bundle = await memory(); const old = widget(); await bundle.backend.write(old.id, old);
    await assert.rejects(mutateDocument({ bundle, id: old.id, mode: "patch", registry: reg, strict: false,
      buildCandidate: d => ({ frontmatter: d!.frontmatter, body: d!.body }) }), KindConformanceError);
    assert.deepEqual(kindConventionDoc(reg.kinds.get("Widget")!, "", "2026-10-20T00:00:00Z").frontmatter.deprecated, policy);
  });
});

test("eligibility: required, standard, managed, terminal, claim and inbound expectation policies refuse", () => {
  const variants: Array<(doc: OkfDocument) => void> = [
    d => { (d.frontmatter.fields as any).required.push("legacy"); },
    d => { (d.frontmatter.deprecated as any).fields = ["generated"]; (d.frontmatter.fields as any).optional.push("generated"); },
    d => { (d.frontmatter.fields as any).terminal = { category: ["old"] }; },
    d => { d.frontmatter.claim = { owner_field: "legacy" }; },
    d => { (d.frontmatter.fields as any).required.push("category"); (d.frontmatter.deprecated as any).values.category = ["old", "new"]; },
  ];
  for (const change of variants) { const doc = structuredClone(deprecationConvention); change(doc); assert.ok(buildKindRegistry([doc]).warnings.some(w => w.code === "KIND_DEPRECATION_INVALID")); }
  const inbound: OkfDocument = { id: "conventions/target", frontmatter: { type: "Convention", governs: "Target", expects_inbound: { legacy_link: "Widget" } }, body: "" };
  const reg = buildKindRegistry([deprecationConvention, inbound]);
  assert.ok(reg.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"));
  assert.ok(kindDeprecationTransition(undefined, widget(), reg).length);
});

test("policy serializer round-trip, logical projection and absent policy preserve legacy behavior", () => {
  const parsed = parseConventionDoc(deprecationConvention); assert.ok(parsed.ok);
  const roundtrip = parseConventionDoc(kindConventionDoc(parsed.kind, "", "2026-10-20T00:00:00Z")); assert.ok(roundtrip.ok);
  assert.deepEqual(roundtrip.kind.deprecated, parsed.kind.deprecated);
  const ordinary = structuredClone(deprecationConvention); delete ordinary.frontmatter.deprecated;
  const reg = buildKindRegistry([ordinary]);
  assert.equal(reg.kinds.get("Widget")!.deprecated, undefined);
  for (const row of deprecationRows) assert.deepEqual(kindDeprecationTransition(row.existing, row.candidate, reg), []);
});

test("fresh CAS retry loses a removed legacy allowance instead of authoring it again", async () => {
  class RacingBackend extends MemoryBackend {
    race = false;
    override async write(id: string, doc: OkfDocument, options?: WriteOptions): Promise<Version> {
      if (this.race) { this.race = false; await super.write(id, widget(), options); }
      return super.write(id, doc, options);
    }
  }
  const backend = new RacingBackend(); const bundle = await memory(backend);
  await backend.write("widgets/one", widget({ legacy: "old" })); backend.race = true;
  let builds = 0;
  await assert.rejects(mutateDocument({ bundle, id: "widgets/one", mode: "patch", registry: registry(), strict: false,
    buildCandidate: d => { builds++; return { frontmatter: { ...d!.frontmatter, legacy: "old", title: "Changed" }, body: d!.body }; } }), KindConformanceError);
  assert.equal(builds, 2);
  assert.equal((await backend.read("widgets/one")).doc.frontmatter.legacy, undefined);
});

function recipe(version: string, deprecated: boolean, governs = "Widget"): LoadedRecipe {
  const convention = structuredClone(deprecationConvention); convention.frontmatter.governs = governs;
  if (!deprecated) delete convention.frontmatter.deprecated;
  return { id: "widget-policy", version, title: "Widget policy", summary: "Policy", offer: "Policy", source: `test:policy:${version}`, docs: [convention], governs: [governs], pages: [], references: [], warnings: [] };
}

test("evolve adds policy with unchanged ownership while legacy instances remain exact bytes", async () => {
  const bundle = await memory(); await installRecipe(bundle, recipe("1", false));
  await bundle.backend.write("widgets/one", widget({ legacy: "old" })); const before = await bundle.backend.read("widgets/one");
  const next = recipe("2", true); const plan = await planRecipeEvolution(bundle, next);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await applyRecipeEvolution(bundle, next, plan.plan_token, { actor: "openai/codex" });
  assert.deepEqual(await bundle.backend.read("widgets/one"), before);
  assert.equal((await planRecipeEvolution(bundle, next)).writes, 0);
  const remove = await planRecipeEvolution(bundle, recipe("3", false));
  assert.equal(remove.ready, false, "ordinary evolution does not silently reactivate deprecated usage");
});

test("evolve refuses lifecycle changes with missing, foreign or diverged recipe ownership", async t => {
  for (const state of ["missing", "foreign", "diverged"]) await t.test(state, async () => {
    const bundle = await memory(); await installRecipe(bundle, recipe("1", false));
    const current = await bundle.backend.read(deprecationConvention.id); const doc = structuredClone(current.doc);
    if (state === "missing") delete doc.frontmatter.x_recipe;
    if (state === "foreign") (doc.frontmatter.x_recipe as any).id = "other";
    if (state === "diverged") doc.body += "Local change\n";
    await bundle.backend.write(doc.id, doc);
    const plan = await planRecipeEvolution(bundle, recipe("2", true));
    assert.ok(plan.blockers.some(b => b.code === "RECIPE_EVOLUTION_DEPRECATION_OWNERSHIP_UNPROVEN"), JSON.stringify(plan));
  });
});

test("recipe Reference asset imports preserve the intentional empty-registry boundary", async () => {
  const bundle = await memory(); const imported = recipe("1", true, "Reference");
  imported.references = [{ doc: { id: "references/guide", frontmatter: { type: "Reference", title: "Guide", legacy: "Imported" }, body: "[legacy_link](other.md)" } }];
  await installRecipe(bundle, imported);
  const asset = await bundle.backend.read("references/guide"); assert.equal(asset.doc.frontmatter.legacy, "Imported");
  const reg = buildKindRegistry([(await bundle.backend.read(deprecationConvention.id)).doc]);
  await assert.rejects(mutateDocument({ bundle, id: "references/new", mode: "create-only", registry: reg, strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Reference", title: "New", legacy: "New" }, body: "" }) }), KindConformanceError);
  const next = recipe("2", true, "Reference"); next.references = [{ doc: { ...imported.references[0]!.doc, body: "Changed imported asset\n[legacy_link](other.md)\n[legacy_link](new.md)" } }];
  const plan = await planRecipeEvolution(bundle, next); assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await applyRecipeEvolution(bundle, next, plan.plan_token);
  assert.match((await bundle.backend.read("references/guide")).doc.body, /new.md/);
});


test("explicit list and multi-action patches share final transition policy", async () => {
  const bundle = await memory(); const old = widget({ topics: ["old"], category: "new" });
  const version = await bundle.backend.write(old.id, old);
  await mutateDocument({ bundle, id: old.id, mode: "patch", expectedVersion: version, registry: registry(), strict: true,
    input: { kind: "field-action", action: { action: "replace-all", field: "topics", value: ["new", "old"] } } });
  await assert.rejects(mutateDocument({ bundle, id: old.id, mode: "patch", registry: registry(), strict: false,
    input: { kind: "field-actions", actions: [{ action: "set", field: "category", value: "old" }] } }), KindConformanceError);
});


test("eligibility agreement rows: resolved claims and legal prototype-named vocabularies", async t => {
  for (const row of deprecationEligibilityRows) await t.test(row.name, async () => {
    const reg = buildKindRegistry([row.convention], [], { okfVersion: "0.2" });
    assert.ok(reg.kinds.has("Widget"), "invalid policy must not erase the readable Kind");
    assert.equal(reg.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"), row.invalid);
    const kind = reg.kinds.get("Widget")!;
    const roundtrip = buildKindRegistry([kindConventionDoc(kind, row.convention.body, "2026-10-20T00:00:00Z")], [], { okfVersion: "0.2" });
    assert.deepEqual(roundtrip.kinds.get("Widget")!.deprecated, kind.deprecated);
    const old = widget(Object.fromEntries([[row.field, "old"]]));
    assert.equal(kindDeprecationTransition(old, { ...old, body: "Unrelated edit" }, reg).length > 0, row.invalid);
    const bundle = await memory(); await bundle.backend.write(old.id, old);
    const mutation = mutateDocument({ bundle, id: old.id, mode: "patch", registry: reg, strict: false,
      buildCandidate: d => ({ frontmatter: d!.frontmatter, body: "Unrelated edit" }) });
    if (row.invalid) await assert.rejects(mutation, KindConformanceError);
    else {
      await mutation;
      await assert.rejects(mutateDocument({ bundle, id: "widgets/new", mode: "create-only", registry: reg, strict: false,
        buildCandidate: () => ({ frontmatter: old.frontmatter, body: "" }) }), KindConformanceError);
    }
    // The same eligibility result must reach the lifecycle front door, without changing instances.
    const target = recipe("2", true); target.docs = [row.convention];
    const initial = recipe("1", false); initial.docs = [structuredClone(row.convention)]; delete initial.docs[0]!.frontmatter.deprecated;
    const lifecycleBundle = await memory();
    if (row.recipeUnsupported) {
      await assert.rejects(installRecipe(lifecycleBundle, initial), /declares both logical/);
      await assert.rejects(planRecipeEvolution(lifecycleBundle, target), /declares both logical/);
      return; // Existing recipe materialization refuses the dual declaration; registry/mutation checks above still apply.
    }
    await installRecipe(lifecycleBundle, initial);
    const plan = await planRecipeEvolution(lifecycleBundle, target);
    assert.equal(plan.ready, !row.invalid, JSON.stringify(plan.blockers));
    if (row.invalid) assert.ok(plan.blockers.some(b => b.code === "KIND_DEPRECATION_INVALID"));
  });
});


test("materialization agreement rows: cross-edition logical/physical policy prepare, install, evolve and transition", async t => {
  for (const row of deprecationMaterializationRows) await t.test(row.name, async () => {
    const source = recipe("2", true); source.docs = [structuredClone(row.convention)]; const before = structuredClone(source);
    const prepared = prepareRecipeInstall(source, { okfVersion: row.edition, now: "2026-10-20T00:00:00Z" });
    const reg = buildKindRegistry(prepared.docs, [], { okfVersion: row.edition });
    const kind = reg.kinds.get("Widget")!;
    assert.ok(kind.fields.optional.includes(row.storageField));
    assert.equal(reg.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"), row.invalid);
    if (row.hasPolicy) {
      assert.ok(kind.deprecated?.fields.includes(row.storageField) || Object.hasOwn(kind.deprecated?.values ?? {}, row.storageField));
      assert.equal(JSON.stringify(prepared.docs[0]!.frontmatter.deprecated).includes('"progress_status"'), false);
    } else assert.equal(kind.deprecated, undefined);
    assert.deepEqual(source, before, "preparation does not rewrite the author's recipe");
    const installed = await memory(); await installed.backend.writeReserved("", "index.md", `---\nokf_version: '${row.edition}'\n---\n`);
    await installRecipe(installed, source);
    const installedPolicy = buildKindRegistry([(await installed.backend.read(row.convention.id)).doc], [], { okfVersion: row.edition });
    assert.equal(installedPolicy.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"), row.invalid,
      "import-like install preserves policy validity/invalidity without claiming authoring admission");
    const create = mutateDocument({ bundle: installed, id: "widgets/new", mode: "create-only", registry: installedPolicy, strict: false,
      buildCandidate: () => ({ frontmatter: widget(Object.fromEntries([[row.storageField, "old"]])).frontmatter, body: "" }) });
    if (row.hasPolicy) await assert.rejects(create, KindConformanceError); else await create;
    const evolving = await memory(); await evolving.backend.writeReserved("", "index.md", `---\nokf_version: '${row.edition}'\n---\n`);
    const baseline = recipe("1", false); baseline.docs = [structuredClone(row.convention)]; delete baseline.docs[0]!.frontmatter.deprecated;
    await installRecipe(evolving, baseline);
    const legacy = widget(Object.fromEntries([[row.storageField, "old"]])); const version = await evolving.backend.write(legacy.id, legacy);
    const plan = await planRecipeEvolution(evolving, source);
    assert.equal(plan.ready, !row.invalid, JSON.stringify(plan.blockers));
    if (row.invalid) assert.ok(plan.blockers.some(b => b.code === "KIND_DEPRECATION_INVALID"));
    else {
      await applyRecipeEvolution(evolving, source, plan.plan_token);
      assert.equal((await evolving.backend.read(legacy.id)).version, version, "evolution does not migrate legacy instances");
      assert.equal((await planRecipeEvolution(evolving, source)).writes, 0);
      const evolvedPolicy = buildKindRegistry([(await evolving.backend.read(row.convention.id)).doc], [], { okfVersion: row.edition });
      const saved = await mutateDocument({ bundle: evolving, id: legacy.id, mode: "patch", registry: evolvedPolicy, strict: false,
        buildCandidate: d => ({ frontmatter: d!.frontmatter, body: "Unrelated edit" }) });
      assert.equal(saved.doc.frontmatter[row.storageField], "old");
    }
  });
});

test("materializer preserves malformed policy payloads, link labels and dual-coordinate refusals", () => {
  const malformed: unknown[] = [null, ["progress_status"], { fields: "progress_status" }, { values: ["progress_status"] },
    { values: { progress_status: "not a list" }, links: ["progress_status"], unknown: { raw: true } },
    { fields: ["progress_status", null], links: ["progress_status"] }];
  for (const policy of malformed) {
    const source = recipe("1", false); source.docs[0]!.frontmatter.fields = { optional: ["progress_status"], values: { progress_status: ["old", "new"] } };
    source.docs[0]!.frontmatter.deprecated = policy; const before = structuredClone(source);
    const prepared = prepareRecipeInstall(source, { okfVersion: "0.2", now: "2026-10-20T00:00:00Z" });
    const reg = buildKindRegistry(prepared.docs, [], { okfVersion: "0.2" });
    assert.ok(reg.warnings.some(w => w.code === "KIND_DEPRECATION_INVALID"));
    assert.deepEqual(source, before);
    const materialized = prepared.docs[0]!.frontmatter.deprecated as any;
    if (policy && !Array.isArray(policy) && typeof policy === "object" && Object.hasOwn(policy, "links")) assert.deepEqual(materialized.links, (policy as any).links);
    if (policy === null || Array.isArray(policy) || typeof (policy as any)?.fields === "string" || Array.isArray((policy as any)?.values)) assert.deepEqual(materialized, policy);
    if ((policy as any)?.values?.progress_status === "not a list") assert.equal(materialized.values.superbee_progress_status, "not a list");
    if (Array.isArray((policy as any)?.fields)) assert.deepEqual(materialized.fields, ["superbee_progress_status", null]);
  }
  for (const policy of [ { fields: ["progress_status", "superbee_progress_status"] },
    { values: { progress_status: ["old"], superbee_progress_status: ["old"] } } ]) {
    const source = recipe("1", false); source.docs[0]!.frontmatter.fields = { optional: ["progress_status"], values: { progress_status: ["old", "new"] } };
    source.docs[0]!.frontmatter.deprecated = policy;
    assert.throws(() => materializeRecipeForEdition(source, "0.2"), /declares both logical/);
  }
});
