import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend } from "../src/memory-backend.js";
import { planRecipeDeclarationRetirement, installRecipe, prepareRecipeInstall } from "../src/recipe-lifecycle/index.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { recipePreflightDigest, type RecipePreflightInput } from "../src/recipe-set-preflight.js";
import type { Bundle, OkfDocument, Version, WriteOptions, ReadResult } from "../src/types.js";
import { parsedRetirementSource, retirementFiles, retirementUsageRows } from "./fixtures/recipe-retirement.js";

class ObservedBackend extends MemoryBackend {
  writes = 0;
  override async write(id: string, doc: OkfDocument, options?: WriteOptions): Promise<Version> { this.writes++; return super.write(id, doc, options); }
}
async function setup(backend = new ObservedBackend()): Promise<Bundle & { backend: ObservedBackend }> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle = { root: "memory://retirement", backend }; await installRecipe(bundle, parsedRetirementSource()); backend.writes = 0; return bundle;
}
const record = (fields: Record<string, unknown> = {}, body = ""): OkfDocument => ({ id: "widgets/one", frontmatter: { type: "Widget", title: "One", ...fields }, body });
async function evidence(bundle: Bundle & { backend: ObservedBackend }, requiredField?: string, source = parsedRetirementSource("2", true)): Promise<RecipePreflightInput> {
  const scan = await planRecipeDeclarationRetirement(bundle, source);
  const artifact = { identity: { publisher: "fixtures", recipeId: source.id, release: source.version }, files: retirementFiles(source).map(f => ({ ...f, digest: recipePreflightDigest(f.bytes) })) };
  const prepared = prepareRecipeInstall(source, { okfVersion: "0.2", now: "1970-01-01T00:00:00.000Z" });
  const definitions = prepared.docs.map(d => ({ id: d.id, bytes: stringifyDoc(d.frontmatter, d.body) }));
  const requirements = [{ id: "widget-use", provider: "candidate", kind: "Widget", required: true, fields: requiredField ? [requiredField] : ["category"] }];
  const consumer = { id: "declared-tool", owner: "candidate", requirements, descriptorDigest: "" }; consumer.descriptorDigest = recipePreflightDigest({ id: consumer.id, owner: consumer.owner, requirements });
  const proposed = new Map(definitions.map(d => [`${d.id}.md`, d.bytes]));
  for (const id of await bundle.backend.list()) if (!proposed.has(`${id}.md`)) { const d = (await bundle.backend.read(id)).doc; proposed.set(`${id}.md`, stringifyDoc(d.frontmatter, d.body)); }
  return { schema: "recipe-set-preflight/v1", selected: [{ key: "candidate", ...artifact.identity, role: "base", artifactDigest: recipePreflightDigest(artifact), artifact }],
    consumers: [consumer], endpoints: [{ id: "widget-local", consumer: consumer.id, requirement: "widget-use", placement: "local" }],
    observations: [{ id: "candidate-local", provider: "candidate", scope: "local", availability: "available", complete: true, observedVersion: scan.local.observation_digest, definitions }],
    placementInventories: [{ id: "local", scope: "local", availability: "available", complete: true, observedVersion: scan.local.observation_digest, files: [...proposed].map(([path, bytes]) => ({ path, bytes })) }] };
}

test("retirement usage agreement rows are read-only, exact and bounded", async t => {
  for (const row of retirementUsageRows) await t.test(row.name, async () => {
    const bundle = await setup(); if (row.fields || row.body) await bundle.backend.write("widgets/one", record(row.fields, row.body)); bundle.backend.writes = 0;
    const before = await Promise.all((await bundle.backend.list()).map(id => bundle.backend.read(id)));
    const source = parsedRetirementSource("2", true);
    if (row.retireTopics) { (source.docs[0]!.frontmatter.fields as any).values.topics = ["new"]; (source.docs[0]!.frontmatter.deprecated as any).values = {}; }
    const original = structuredClone(source);
    const report = await planRecipeDeclarationRetirement(bundle, source);
    assert.equal(report.can_apply, false); assert.equal(report.apply_blocker, "RETIREMENT_APPLY_NOT_IMPLEMENTED");
    assert.equal(report.declarations.length, row.retireTopics ? 4 : 3, JSON.stringify(report.blockers));
    assert.equal(report.local.verdict, row.verdict, JSON.stringify(report));
    assert.equal(report.local.complete, true); assert.equal(report.consumers.status, "unassessed");
    assert.equal(report.external_consumers, "unknown-unenumerated-offline-and-arbitrary-code");
    if (row.coordinate) assert.equal(report.declarations.find(d => d.coordinate === row.coordinate && (!row.declarationName || row.declarationName === d.name))!.usage.reduce((n, use) => n + use.count, 0), row.count);
    assert.deepEqual(source, original); assert.equal(bundle.backend.writes, 0);
    assert.deepEqual(await Promise.all((await bundle.backend.list()).map(id => bundle.backend.read(id))), before);
    assert.deepEqual(await planRecipeDeclarationRetirement(bundle, source), report);
    assert.equal(Object.hasOwn(report, "plan_token"), false); assert.equal(Object.hasOwn(report, "ready"), false);
  });
});

test("unreadable records and changing membership/versions remain unknown, never clean", async t => {
  class Unreadable extends ObservedBackend { bad = false; override async read(id: string): Promise<ReadResult> { if (this.bad && id === "widgets/one") throw new Error("unreadable fixture"); return super.read(id); } }
  class MembershipRace extends ObservedBackend { active = false; override async list(prefix?: string): Promise<string[]> { if (this.active && prefix === undefined) { this.active = false; await this.write("widgets/phantom", { ...record({ legacy: "old" }), id: "widgets/phantom" }); } return super.list(prefix); } }
  for (const kind of ["unreadable", "membership", "version"] as const) await t.test(kind, async () => {
    const backend = kind === "unreadable" ? new Unreadable() : kind === "membership" ? new MembershipRace() : new ObservedBackend();
    const bundle = await setup(backend); await backend.write("widgets/one", record());
    if (backend instanceof Unreadable) backend.bad = true;
    if (backend instanceof MembershipRace) {
      const original = backend.read.bind(backend); let once = true;
      backend.read = async id => { const value = await original(id); if (once) { once = false; backend.active = true; } return value; };
    }
    if (kind === "version") {
      const original = backend.read.bind(backend); let reads = 0;
      backend.read = async id => { if (id === "widgets/one" && ++reads === 2) await backend.write(id, record({ legacy: "old" })); return original(id); };
    }
    const report = await planRecipeDeclarationRetirement(bundle, parsedRetirementSource("2", true));
    assert.equal(report.local.complete, false); assert.equal(report.local.verdict, "unknown", JSON.stringify(report.local));
    assert.ok(report.local.issues.length); assert.equal(report.can_apply, false);
  });
});

test("only previously deprecated, unchanged own source omissions are candidates", async t => {
  for (const change of ["undeclared", "foreign", "missing", "diverged", "required", "type", "retarget", "whole-definition"] as const) await t.test(change, async () => {
    const bundle = await setup(); const source = parsedRetirementSource("2", true);
    if (["foreign", "missing", "diverged"].includes(change)) {
      const doc = (await bundle.backend.read("conventions/widget")).doc;
      if (change === "foreign") (doc.frontmatter.x_recipe as any).id = "someone-else";
      if (change === "missing") delete doc.frontmatter.x_recipe;
      if (change === "diverged") doc.body += "Local edit";
      await bundle.backend.write(doc.id, doc);
    } else if (change === "undeclared") {
      (source.docs[0]!.frontmatter.fields as any).optional = ["topics"]; delete (source.docs[0]!.frontmatter.fields as any).values.category; delete (source.docs[0]!.frontmatter.fields as any).value_descriptions.category;
    } else if (change === "required") (source.docs[0]!.frontmatter.fields as any).required.push("new_required");
    else if (change === "type") (source.docs[0]!.frontmatter.fields as any).types.topics = "slug";
    else if (change === "retarget") (source.docs[0]!.frontmatter.links as any).active_link = "Other";
    else source.docs = [{ ...source.docs[0]!, id: "conventions/other", frontmatter: { type: "Convention", governs: "Other" } }];
    const report = await planRecipeDeclarationRetirement(bundle, source);
    assert.equal(report.analysis, "refused", JSON.stringify(report)); assert.ok(report.blockers.length);
    assert.notEqual(report.local.verdict, "complete-clean");
  });
});

test("actual preflight is bound to this candidate, inventory and declared consumer requirement", async () => {
  const bundle = await setup(); const source = parsedRetirementSource("2", true);
  const input = await evidence(bundle); const original = structuredClone(input);
  const accepted = await planRecipeDeclarationRetirement(bundle, source, { consumerEvidence: input });
  assert.equal(accepted.consumers.status, "valid", JSON.stringify(accepted.consumers)); assert.equal(accepted.consumers.result?.verdict, "valid");
  assert.equal(accepted.consumers.evidence_digest, recipePreflightDigest(input)); assert.deepEqual(input, original);
  const required = await planRecipeDeclarationRetirement(bundle, source, { consumerEvidence: await evidence(bundle, "legacy") });
  assert.equal(required.consumers.status, "refused"); assert.ok(required.consumers.result!.issues.some(i => i.code === "REQUIRED_FIELD_MISSING"));
  const unsupported = await evidence(bundle); unsupported.consumers[0]!.requirements![0]!.unsupported = ["enum-values", "write-intent"];
  const c = unsupported.consumers[0]!; c.descriptorDigest = recipePreflightDigest({ id: c.id, owner: c.owner, requirements: c.requirements });
  const partial = await planRecipeDeclarationRetirement(bundle, source, { consumerEvidence: unsupported });
  assert.equal(partial.consumers.status, "partial"); assert.ok(partial.consumers.result!.issues.some(i => i.code === "UNSUPPORTED_CONSTRAINT"));
});

test("unrelated/stale/contradictory evidence cannot borrow valid structural assessment", async t => {
  for (const change of ["old-source", "self-consistent-other-source", "stale-token", "wrong-model", "extra-inventory", "omitted-record", "empty", "malformed"] as const) await t.test(change, async () => {
    const bundle = await setup(); await bundle.backend.write("widgets/one", record());
    const source = parsedRetirementSource("2", true); const input: any = await evidence(bundle, undefined, change === "self-consistent-other-source" ? parsedRetirementSource("2", false) : source);
    if (change === "old-source") { const old = parsedRetirementSource("2", false); input.selected[0].artifact.files = retirementFiles(old).map(f => ({ ...f, digest: recipePreflightDigest(f.bytes) })); input.selected[0].artifactDigest = recipePreflightDigest(input.selected[0].artifact); }
    if (change === "stale-token") input.observations[0].observedVersion = "previous-scan";
    if (change === "wrong-model") input.observations[0].definitions[0].bytes = input.observations[0].definitions[0].bytes.replace('category', 'wrong_category');
    if (change === "extra-inventory") input.placementInventories[0].files.push({ path: "extra.md", bytes: "---\ntype: Widget\n---\n" });
    if (change === "omitted-record") input.placementInventories[0].files = input.placementInventories[0].files.filter((f: any) => f.path !== "widgets/one.md");
    const supplied = change === "empty" ? { ...input, consumers: [] } : change === "malformed" ? null : input;
    const report = await planRecipeDeclarationRetirement(bundle, source, { consumerEvidence: supplied });
    if (change === "empty") assert.notEqual(report.consumers.status, "valid");
    else assert.equal(report.consumers.status, "refused", JSON.stringify(report.consumers));
    if (change === "self-consistent-other-source" || change === "omitted-record") assert.equal(report.consumers.result?.verdict, "valid", "a valid unrelated/incomplete preflight does not bind it to this retirement");
    assert.equal(report.can_apply, false);
  });
});


test("no descriptors remain unassessed even with complete otherwise valid supplied evidence", async () => {
  const bundle = await setup(); const input = await evidence(bundle); input.consumers = []; input.endpoints = [];
  const report = await planRecipeDeclarationRetirement(bundle, parsedRetirementSource("2", true), { consumerEvidence: input });
  assert.equal(report.consumers.status, "unassessed"); assert.equal(report.consumers.result?.verdict, "valid");
});

test("inspection after one completed definition retains the observed partial state without synthetic blockers", async () => {
  const old = parsedRetirementSource();
  old.docs.push({ ...structuredClone(old.docs[0]!), id: "conventions/second", frontmatter: { ...structuredClone(old.docs[0]!.frontmatter), governs: "Second" } }); old.governs.push("Second");
  // Both definitions retain their real shared source identity during partial completion.
  const backend = new ObservedBackend(); await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n"); const target = { root: "memory://partial-retirement", backend };
  await installRecipe(target, old);
  const source = parsedRetirementSource("2", true);
  source.docs.push({ ...structuredClone(source.docs[0]!), id: "conventions/second", frontmatter: { ...structuredClone(source.docs[0]!.frontmatter), governs: "Second" } }); source.governs.push("Second");
  const prepared = prepareRecipeInstall(source, { okfVersion: "0.2", now: "1970-01-01T00:00:00.000Z" });
  await backend.write("conventions/widget", prepared.docs[0]!);
  const report = await planRecipeDeclarationRetirement(target, source);
  assert.deepEqual(report.blockers, []); assert.equal(report.declarations.length, 3);
  assert.ok(report.declarations.every(row => row.definition === "conventions/second"));
  assert.equal(report.local.inventory.length, 2); assert.equal(report.local.verdict, "complete-clean");
});


test("legal prototype-named enum retirements reuse owning membership and safe restoration", async () => {
  for (const field of ["constructor", "toString", "__proto__"]) {
    const old = parsedRetirementSource(); old.docs[0]!.frontmatter.fields = { required: ["title"], optional: [field], values: Object.fromEntries([[field, ["old", "new"]]]) };
    old.docs[0]!.frontmatter.deprecated = { values: Object.fromEntries([[field, ["old"]]]) };
    delete old.docs[0]!.frontmatter.links; delete old.docs[0]!.frontmatter.link_descriptions;
    const backend = new ObservedBackend(); await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n"); const bundle = { root: "memory://prototype-retirement", backend };
    await installRecipe(bundle, old); await backend.write("widgets/one", record(Object.fromEntries([[field, "old"]])));
    const source = structuredClone(old); source.version = "2"; (source.docs[0]!.frontmatter.fields as any).values = Object.fromEntries([[field, ["new"]]]); source.docs[0]!.frontmatter.deprecated = {};
    const report = await planRecipeDeclarationRetirement(bundle, source);
    assert.deepEqual(report.blockers, []); assert.equal(report.declarations[0]?.name, field); assert.equal(report.local.verdict, "used");
  }
});
