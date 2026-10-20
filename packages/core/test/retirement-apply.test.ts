import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryBackend } from "../src/memory-backend.js";
import { FilesystemBackend } from "../src/backend.js";
import { mutateDocument } from "../src/document-mutation.js";
import { buildKindRegistry } from "../src/kinds.js";
import { INVENTORY_GUARD_DOMAIN, InventoryGuardUnsupported, type InventoryGuardRequest } from "../src/inventory-guard.js";
import { installRecipe, planRecipeEvolution, planRecipeDeclarationRetirement, planRecipeDeclarationRetirementApply, applyRecipeDeclarationRetirement, RecipeRetirementApplyError } from "../src/recipe-lifecycle/index.js";
import { definitionDigest, recipeSourceDigest, readRecipeStamp, recipeStampIdentity } from "../src/recipe-lifecycle/stamp.js";
import { prepareRecipeInstall } from "../src/recipe-lifecycle/install.js";
import { recipePreflightDigest, type RecipePreflightInput } from "../src/recipe-set-preflight.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { InvalidInputError } from "../src/errors.js";
import type { Bundle, StorageBackend } from "../src/types.js";
import type { LoadedRecipe } from "../src/recipes.js";
import { parsedRetirementSource, retirementFiles } from "./fixtures/recipe-retirement.js";

const scope = INVENTORY_GUARD_DOMAIN;
function sourcePair(version = "1", retire = false): LoadedRecipe {
  const source = parsedRetirementSource(version, retire);
  const second = structuredClone(source.docs[0]!);
  second.id = "conventions/z-gadget"; second.frontmatter.governs = "Gadget"; second.frontmatter.title = "Gadget"; second.body = "# Gadget\n";
  source.docs.push(second); source.governs.push("Gadget"); return source;
}
async function setup(kind: "memory" | "filesystem" = "memory", paired = false, edition = "0.2") {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "retirement-apply-"));
  const backend: StorageBackend = kind === "memory" ? new MemoryBackend() : new FilesystemBackend(directory);
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  const bundle = { root: kind === "memory" ? "memory://retirement-apply" : directory, backend };
  await installRecipe(bundle, paired ? sourcePair() : parsedRetirementSource());
  return { bundle, directory, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
const state = async (backend: StorageBackend) => Promise.all((await backend.list()).map(id => backend.read(id)));
async function evidence(bundle: Bundle, source: LoadedRecipe, required = "category"): Promise<RecipePreflightInput> {
  const scan = await planRecipeDeclarationRetirement(bundle, source);
  const artifact = { identity: { publisher: "fixtures", recipeId: source.id, release: source.version }, files: retirementFiles(source).map(file => ({ ...file, digest: recipePreflightDigest(file.bytes) })) };
  const installation = prepareRecipeInstall(source, { okfVersion: "0.2", now: "1970-01-01T00:00:00.000Z" });
  const definitions = installation.docs.map(doc => ({ id: doc.id, bytes: stringifyDoc(doc.frontmatter, doc.body) }));
  const requirements = [{ id: "use", provider: "candidate", kind: "Widget", required: true, fields: [required] }];
  const consumer = { id: "tool", owner: "candidate", requirements, descriptorDigest: recipePreflightDigest({ id: "tool", owner: "candidate", requirements }) };
  const files = new Map(definitions.map(doc => [`${doc.id}.md`, doc.bytes]));
  for (const id of await bundle.backend!.list()) if (!files.has(`${id}.md`)) { const doc = (await bundle.backend!.read(id)).doc; files.set(`${id}.md`, stringifyDoc(doc.frontmatter, doc.body)); }
  return { schema: "recipe-set-preflight/v1", selected: [{ key: "candidate", ...artifact.identity, role: "base", artifactDigest: recipePreflightDigest(artifact), artifact }], consumers: [consumer],
    endpoints: [{ id: "local-use", consumer: "tool", requirement: "use", placement: "local" }],
    observations: [{ id: "local", provider: "candidate", scope: "local", availability: "available", complete: true, observedVersion: scan.local.observation_digest, definitions }],
    placementInventories: [{ id: "local", scope: "local", availability: "available", complete: true, observedVersion: scan.local.observation_digest, files: [...files].map(([path, bytes]) => ({ path, bytes })) }] };
}
for (const kind of ["memory", "filesystem"] as const) for (const edition of ["0.1", "0.2"]) {
  test(`${kind}/${edition}: one stage retires all eligible coordinates with actual stamp and unchanged records/source`, async () => {
    const f = await setup(kind, false, edition);
    try {
      const source = parsedRetirementSource("2", true); const beforeSource = structuredClone(source);
      await f.bundle.backend.write("widgets/one", { id: "widgets/one", frontmatter: { type: "Widget", title: "One", category: "new" }, body: "" });
      const record = await f.bundle.backend.read("widgets/one");
      // Local placement is excluded from recipe ownership but remains an evolution-owned value.
      const current = await f.bundle.backend.read("conventions/widget");
      await f.bundle.backend.write(current.doc.id, { ...current.doc, frontmatter: { ...current.doc.frontmatter, order: 99 } });
      const plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
      assert.equal(plan.ready_for_next_stage, true, JSON.stringify(plan.blockers));
      assert.deepEqual(await planRecipeDeclarationRetirementApply(f.bundle, source, { scope }), plan);
      const result = await applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope, actor: "openai/codex" });
      assert.equal(result.completed.length, 1); assert.equal(result.complete, true); assert.equal(result.refresh_needed, false);
      const saved = await f.bundle.backend.read(plan.next_definition!);
      assert.equal(saved.doc.frontmatter.order, 99);
      const stamp = readRecipeStamp(saved.doc)!;
      assert.equal(stamp.source_digest, recipeStampIdentity(source, { ...source }).source_digest);
      assert.equal(stamp.definition, definitionDigest(saved.doc));
      assert.equal((saved.doc.frontmatter.fields as any).optional.includes("legacy"), false);
      assert.deepEqual((saved.doc.frontmatter.fields as any).values.category, ["new"]);
      assert.equal(Object.hasOwn(saved.doc.frontmatter.links as object, "legacy_link"), false);
      assert.equal(saved.version, result.completed[0]!.version);
      assert.deepEqual(await f.bundle.backend.read("widgets/one"), record);
      assert.deepEqual(source, beforeSource);
      const after = await state(f.bundle.backend);
      await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope }), RecipeRetirementApplyError);
      assert.deepEqual(await state(f.bundle.backend), after);
      assert.equal((await planRecipeDeclarationRetirement(f.bundle, source)).can_apply, false);
    } finally { await f.cleanup(); }
  });
}
for (const row of ["used", "unknown", "scope", "source", "stale", "foreign", "required"] as const) {
  test(`retirement refuses ${row} without source or record mutation`, async () => {
    const f = await setup();
    try {
      const source = parsedRetirementSource("2", true);
      const old = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
      if (row === "used" || row === "unknown") await f.bundle.backend.write("widgets/one", { id: "widgets/one", frontmatter: { type: "Widget", title: "One", ...(row === "used" ? { legacy: null } : {}) }, body: row === "unknown" ? "[legacy_link](okf://INVALID/widgets/two.md)" : "" });
      if (row === "source") (source.docs[0]!.frontmatter.fields as any).optional.push("future");
      if (row === "required") (source.docs[0]!.frontmatter.fields as any).required.push("future");
      if (row === "stale") await f.bundle.backend.write("widgets/other", { id: "widgets/other", frontmatter: { type: "Widget", title: "Other" }, body: "" });
      if (row === "foreign") { const current = await f.bundle.backend.read("conventions/widget"); (current.doc.frontmatter.x_recipe as any).id = "foreign"; await f.bundle.backend.write(current.doc.id, current.doc); }
      const before = await state(f.bundle.backend), original = structuredClone(source);
      await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, old.plan_token!, row === "scope" ? {} : { scope }), RecipeRetirementApplyError);
      assert.deepEqual(await state(f.bundle.backend), before); assert.deepEqual(source, original);
    } finally { await f.cleanup(); }
  });
}
test("sequential definitions require a fresh token and retain completed actual-source baselines", async () => {
  const f = await setup("memory", true);
  try {
    const source = sourcePair("2", true);
    const first = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    const receipt = await applyRecipeDeclarationRetirement(f.bundle, source, first.plan_token!, { scope });
    assert.deepEqual(receipt.pending_definitions, ["conventions/z-gadget"]); assert.equal(receipt.complete, false); assert.equal(receipt.refresh_needed, true);
    const stored = await f.bundle.backend.read(first.next_definition!);
    await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, first.plan_token!, { scope }), error => error instanceof RecipeRetirementApplyError && error.reason === "plan_changed");
    assert.deepEqual(await f.bundle.backend.read(first.next_definition!), stored);
    const second = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    assert.equal(second.ready_for_next_stage, true, JSON.stringify(second.blockers)); assert.equal(second.next_definition, "conventions/z-gadget");
    const final = await applyRecipeDeclarationRetirement(f.bundle, source, second.plan_token!, { scope });
    assert.equal(final.complete, true); assert.equal(final.completed[0]!.id, "conventions/z-gadget");
  } finally { await f.cleanup(); }
});
test("supplied final model evidence cannot certify a mixed intermediate stage", async () => {
  const f = await setup("memory", true);
  try {
    const source = sourcePair("2", true), consumerEvidence = await evidence(f.bundle, source);
    const plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope, consumerEvidence });
    assert.equal(plan.consumers.status, "valid", JSON.stringify(plan.consumers));
    assert.equal(plan.ready_for_next_stage, false); assert.ok(plan.blockers.some(row => row.code === "RETIREMENT_STAGE_CONSUMER_UNREPRESENTABLE"));
    const before = await state(f.bundle.backend);
    await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, "retirement-apply/v1:sha256:" + "0".repeat(64), { scope, consumerEvidence }));
    assert.deepEqual(await state(f.bundle.backend), before);
  } finally { await f.cleanup(); }
});
test("single concrete stage reuses actual supplied consumer preflight, removed required field refuses", async () => {
  const f = await setup();
  try {
    const source = parsedRetirementSource("2", true);
    const good = await evidence(f.bundle, source);
    const valid = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope, consumerEvidence: good });
    assert.equal(valid.ready_for_next_stage, true, JSON.stringify(valid.blockers));
    const bad = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope, consumerEvidence: await evidence(f.bundle, source, "legacy") });
    assert.equal(bad.ready_for_next_stage, false); assert.equal(bad.consumers.status, "refused");
    await applyRecipeDeclarationRetirement(f.bundle, source, valid.plan_token!, { scope, consumerEvidence: good });
  } finally { await f.cleanup(); }
});
test("guarded mutation permits only pinned existing replacements; ordinary additive evolve remains blocked", async () => {
  const f = await setup();
  try {
    const backend = f.bundle.backend, target = await backend.inventoryGuard!.observeTarget();
    const inventory = await Promise.all((await backend.list()).map(async id => ({ id, version: (await backend.read(id)).version })));
    await assert.rejects(mutateDocument({ bundle: f.bundle, id: "conventions/widget", mode: "overwrite", registry: buildKindRegistry([]), strict: false,
      inventoryGuard: { target, domain: scope, inventory }, buildCandidate: () => ({ frontmatter: { type: "Convention" }, body: "" }) }), InvalidInputError);
    const additive = await planRecipeEvolution(f.bundle, parsedRetirementSource("2", true));
    assert.equal(additive.ready, false); assert.ok(additive.blockers.some(row => row.code === "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED"));
  } finally { await f.cleanup(); }
});
test("late phantom at mutation deciding read is refused by the actual inventory persistence route", async () => {
  const f = await setup();
  const original = MemoryBackend.prototype.read;
  try {
    const source = parsedRetirementSource("2", true), plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    const before = await original.call(f.bundle.backend, "conventions/widget"); let fired = false;
    MemoryBackend.prototype.read = async function(id) {
      const result = await original.call(this, id);
      if (this === f.bundle.backend && id === "conventions/widget" && !fired && new Error().stack?.includes("readExisting")) {
        fired = true;
        await this.write("widgets/phantom", { id: "widgets/phantom", frontmatter: { type: "Widget", title: "Phantom", legacy: "old" }, body: "" });
      }
      return result;
    };
    await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope }), error => error instanceof RecipeRetirementApplyError && error.reason === "interrupted");
    assert.equal(fired, true); assert.equal((await original.call(f.bundle.backend, "conventions/widget")).version, before.version);
    assert.equal(await f.bundle.backend.exists("widgets/phantom"), true);
  } finally { MemoryBackend.prototype.read = original; await f.cleanup(); }
});


test("ordinary mutation resolves a bare bundle backend exactly once", async () => {
  const { setDefaultBackendFactory } = await import("../src/bundle-ops.js");
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  await backend.write("notes/a", { id: "notes/a", frontmatter: { type: "Note" }, body: "before" });
  let resolutions = 0;
  setDefaultBackendFactory(() => { resolutions++; if (resolutions > 1) throw new Error("backend rebound"); return backend; });
  try {
    const receipt = await mutateDocument({ bundle: { root: "memory://bare" }, id: "notes/a", mode: "replace-document", onAbsent: "fail", registry: buildKindRegistry([]), strict: false,
      buildCandidate: old => ({ frontmatter: old!.frontmatter, body: "after" }) });
    assert.equal(receipt.changed, true); assert.equal(resolutions, 1);
    assert.equal((await backend.read("notes/a")).version, receipt.version);
  } finally { setDefaultBackendFactory(undefined); }
});

for (const kind of ["memory", "filesystem"] as const) test(`${kind}: legal mixed-case inventory uses storage-owner ordering`, async () => {
  const f = await setup(kind);
  try {
    for (const id of ["notes/Z", "notes/a"]) await f.bundle.backend.write(id, { id, frontmatter: { type: "Note" }, body: "" });
    const source = parsedRetirementSource("2", true);
    const plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    assert.equal(plan.ready_for_next_stage, true);
    assert.equal((await applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope })).complete, true);
  } finally { await f.cleanup(); }
});
test("typed invalid actor remains a proven prewrite refusal", async () => {
  const f = await setup();
  try {
    const source = parsedRetirementSource("2", true), before = await state(f.bundle.backend);
    const plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope, actor: "bad-actor" }), error => error instanceof InvalidInputError && error.name === "OkfActorError");
    assert.deepEqual(await state(f.bundle.backend), before);
  } finally { await f.cleanup(); }
});

test("typed guard unsupported remains a proven prewrite refusal", async () => {
  const f = await setup(), original = MemoryBackend.prototype.read;
  try {
    const source = parsedRetirementSource("2", true), plan = await planRecipeDeclarationRetirementApply(f.bundle, source, { scope });
    const before = await state(f.bundle.backend); let fired = false;
    const refusal = new InventoryGuardUnsupported("inventory_document_bound");
    MemoryBackend.prototype.read = async function(id) {
      if (this === f.bundle.backend && new Error().stack?.includes("readExisting")) { fired = true; throw refusal; }
      return original.call(this, id);
    };
    await assert.rejects(applyRecipeDeclarationRetirement(f.bundle, source, plan.plan_token!, { scope }), error => error === refusal && error.written === false);
    assert.equal(fired, true); assert.deepEqual(await state(f.bundle.backend), before);
  } finally { MemoryBackend.prototype.read = original; await f.cleanup(); }
});
