/**
 * `@superbee/core/recipe-lifecycle` on MemoryBackend: install, plan and apply through core alone,
 * plan-token byte identity with the CLI's golden transcript, and one named path per typed error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle } from "../src/bundle.js";
import { readBlob, readDoc, writeBlob, writeDoc } from "../src/bundle-ops.js";
import { InvalidInputError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipes.js";
import type { Bundle, ConceptId, OkfDocument, ReservedFilename, ReservedReadResult, Version, WriteOptions } from "../src/types.js";
import {
  applyRecipeEvolution,
  DEFINITION_DIGEST_RULES,
  definitionDigest,
  installRecipe,
  installedConventionDocs,
  installedRecipes,
  readRecipeStamp,
  RECIPE_STAMP_KEY,
  recipeSourceDigest,
  isRecipeApplied,
  materializeRecipeForEdition,
  planRecipeEvolution,
  recipeDrifts,
  RecipeAssetConflict,
  RecipeEditionChanged,
  RecipeEvolutionBlocked,
  RecipeEvolutionInterrupted,
  RecipeEvolutionPlanChanged,
  RecipeEvolutionPostcondition,
  RecipeInputError,
  RecipeLifecycleError,
} from "../src/recipe-lifecycle/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = "2026-10-14T12:00:00.000Z";

// The scenario of packages/cli/test/recipe-evolve-golden.test.ts, first case.
const GOLDEN = path.resolve(here, "../../cli/test/fixtures/recipe-evolve-golden/plans.txt");
const manifest = (version: string): string =>
  `---\ntype: Recipe\nid: widget-workflow\ntitle: Widget workflow\nversion: "${version}"\nsummary: Widget definitions.\n---\n`;
const convention = (fields: string, extra = ""): string =>
  `---\ntype: Convention\ntitle: Widget\ngoverns: Widget\npath: widgets/\nfields:\n${fields}${extra}---\n# Widget\n`;
const INSTALLED = convention(
  "  required: [title]\n  optional: [setting, size]\n  values:\n    setting: [indoor, outdoor]\n",
  "x_field_types:\n  size: string\n",
);
const NEW_OPTIONAL_FIELD = convention(
  "  required: [title]\n  optional: [setting, size, colour]\n  values:\n    setting: [indoor, outdoor]\n",
  "x_field_types:\n  size: string\n",
);
const NEWLY_REQUIRED_FIELD = convention(
  "  required: [title, priority]\n  optional: [setting, size]\n  values:\n    setting: [indoor, outdoor]\n",
  "x_field_types:\n  size: string\n",
);

function loadRecipe(version: string, conventionText: string): LoadedRecipe {
  const loaded = parseRecipeFiles(
    [
      { path: "recipe.md", bytes: manifest(version) },
      { path: "conventions/widget.md", bytes: conventionText },
    ],
    `test:evolve-golden:${version}`,
    { okfVersion: "0.2" },
  );
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
  return loaded.recipe;
}

async function v02Bundle(name: string, backend: MemoryBackend = new MemoryBackend()): Promise<Bundle> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Recipe lifecycle\n");
  return { root: `mem://${name}`, backend };
}

/** The golden scenario's bundle: v1 installed, plus one instance in use. */
async function installedWidgetBundle(name: string, backend?: MemoryBackend): Promise<Bundle> {
  const bundle = await v02Bundle(name, backend);
  await installRecipe(bundle, loadRecipe("1", INSTALLED), { now: NOW });
  await writeDoc(bundle, {
    id: "widgets/one",
    frontmatter: { type: "Widget", title: "One", setting: "outdoor", size: "large", finish: "satin" },
    body: "In use.",
  });
  return bundle;
}

const VIEW_HTML = "<!doctype html><p>Ünïcödé gallery 🐝</p>\n";

/** A hand-built recipe with one convention and one View pair (registry plus HTML). */
function galleryRecipe(version: string, optional: string[] = [], html = VIEW_HTML): LoadedRecipe {
  return {
    id: "gallery",
    title: "Gallery",
    version,
    summary: "A gallery Kind and its View.",
    offer: "Gallery",
    source: `test:gallery:${version}`,
    docs: [{
      id: "conventions/exhibit",
      frontmatter: { type: "Convention", title: "Exhibit", governs: "Exhibit", fields: { required: ["title"], optional } },
      body: "# Exhibit\n",
    }],
    pages: [{
      registry: {
        id: "views-registry/gallery",
        frontmatter: { type: "View", title: "Gallery", entry: "views/gallery/index.html", access: "none" },
        body: "Every exhibit.\n",
      },
      entry: "views/gallery/index.html",
      html,
    }],
    references: [],
    governs: ["Exhibit"],
    warnings: [],
  };
}

test("install, plan and apply run through core alone, and the plan token is byte-identical to the CLI golden", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const bundle = await installedWidgetBundle("golden");
  const desired = loadRecipe("2", NEW_OPTIONAL_FIELD);

  const plan = await planRecipeEvolution(bundle, desired);
  const golden = await readFile(GOLDEN, "utf8");
  const goldenFirstToken = /"plan_token": "(sha256:[0-9a-f]{64})"/.exec(golden)?.[1];
  assert.ok(goldenFirstToken, "the golden transcript names a plan token");
  assert.equal(plan.plan_token, goldenFirstToken);
  assert.equal(golden.split("\n## ")[0], `## ready: a new optional field\n${JSON.stringify(plan, null, 2)}`);

  const applied = await applyRecipeEvolution(bundle, desired, plan.plan_token, { actor: "process:recipe-test" });
  assert.equal(applied.recipe, "evolved");
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.counts, { updated: 1, stamped: 0, unchanged: 0 });
  const kind = (await readDoc(bundle, "conventions/widget")).frontmatter.fields as Record<string, unknown>;
  assert.deepEqual(kind.optional, ["setting", "size", "colour"]);

  const settled = await planRecipeEvolution(bundle, desired);
  assert.equal(settled.ready, true);
  assert.equal(settled.changed, false);
});

test("install is create-only and idempotent; the drift and applied checks read installed conventions", async () => {
  const bundle = await v02Bundle("install");
  const recipe = galleryRecipe("1");
  const first = await installRecipe(bundle, recipe, { now: NOW });
  assert.equal(first.changed, true);
  assert.deepEqual(first.counts, { created: 2, existing: 0, legacy_present: 0, migration_required: 0 });
  const blob = await readBlob(bundle, "views/gallery/index.html");
  assert.deepEqual(blob?.bytes, new TextEncoder().encode(VIEW_HTML));

  const second = await installRecipe(bundle, recipe, { now: NOW });
  assert.equal(second.changed, false);
  assert.deepEqual(second.counts, { created: 0, existing: 2, legacy_present: 0, migration_required: 0 });

  const installed = await installedConventionDocs(bundle);
  assert.deepEqual([...installed.keys()], ["conventions/exhibit"]);
  assert.equal(isRecipeApplied(recipe, new Set(installed.keys())), true);
  assert.equal(recipeDrifts(recipe, installed, "0.2", NOW), false);
  assert.equal(recipeDrifts(galleryRecipe("2", ["room"]), installed, "0.2", NOW), true);
});

test("RecipeInputError: materialization refuses an unsupported edition and a dual-declared workflow field", () => {
  const recipe = galleryRecipe("1");
  assert.throws(() => materializeRecipeForEdition(recipe, "9.9"), (error: unknown) =>
    error instanceof RecipeInputError
    && error instanceof RecipeLifecycleError
    && error.message === "recipe 'gallery' cannot target unsupported OKF mutation version '9.9'");
  const dual: LoadedRecipe = {
    ...recipe,
    docs: [{ ...recipe.docs[0]!, frontmatter: { ...recipe.docs[0]!.frontmatter, fields: { required: ["title", "progress_status", "superbee_progress_status"] } } }],
  };
  assert.throws(() => materializeRecipeForEdition(dual, "0.2"), (error: unknown) =>
    error instanceof RecipeInputError
    && /declares both logical 'progress_status' and storage field 'superbee_progress_status'/.test(error.message));
});

test("RecipeAssetConflict: a different existing View blob is refused before any write", async () => {
  const bundle = await v02Bundle("asset-conflict");
  await writeBlob(bundle, "views/gallery/index.html", new TextEncoder().encode("<p>the bundle's own page</p>"));
  await assert.rejects(installRecipe(bundle, galleryRecipe("1"), { now: NOW }), (error: unknown) =>
    error instanceof RecipeAssetConflict && error.recipe === "gallery" && error.key === "views/gallery/index.html");
  assert.deepEqual([...(await installedConventionDocs(bundle)).keys()], []);
});

test("RecipeAssetConflict: a same-length but different existing View blob is refused", async () => {
  const bundle = await v02Bundle("asset-conflict-same-length");
  const different = new TextEncoder().encode(VIEW_HTML);
  different[different.length - 2] = different[different.length - 2]! ^ 0x01;
  await writeBlob(bundle, "views/gallery/index.html", different);
  await assert.rejects(installRecipe(bundle, galleryRecipe("1"), { now: NOW }), (error: unknown) =>
    error instanceof RecipeAssetConflict && error.key === "views/gallery/index.html");
  assert.deepEqual((await readBlob(bundle, "views/gallery/index.html"))?.bytes, different);
});

/** MemoryBackend whose bundle edition reads as 0.1 once `flipAfterReads` more reads have passed. */
class EditionFlipBackend extends MemoryBackend {
  flipAfterReads: number | null = null;

  override async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    const result = await super.readReserved(dir, name);
    if (this.flipAfterReads === null || name !== "index.md" || result === null) return result;
    if (this.flipAfterReads > 0) {
      this.flipAfterReads -= 1;
      return result;
    }
    return { ...result, content: result.content.replace("okf_version: '0.2'", "okf_version: '0.1'") };
  }
}

test("RecipeEditionChanged: the edition moving between install's read and its create is refused", async () => {
  const backend = new EditionFlipBackend();
  const bundle = await v02Bundle("install-edition", backend);
  backend.flipAfterReads = 1;
  await assert.rejects(installRecipe(bundle, loadRecipe("1", INSTALLED), { now: NOW }), (error: unknown) =>
    error instanceof RecipeEditionChanged
    && error.from === "0.2"
    && error.to === "0.1"
    && error.message === "bundle OKF version changed from '0.2' to '0.1' during recipe installation; retry");
});

test("RecipeEvolutionPlanChanged and RecipeEvolutionBlocked: apply refuses a stale token and a blocked plan", async () => {
  const bundle = await installedWidgetBundle("plan-refusals");
  const ready = loadRecipe("2", NEW_OPTIONAL_FIELD);
  const plan = await planRecipeEvolution(bundle, ready);
  await assert.rejects(applyRecipeEvolution(bundle, ready, "sha256:stale"), (error: unknown) =>
    error instanceof RecipeEvolutionPlanChanged && error.expected === "sha256:stale" && error.current === plan.plan_token);

  const blocked = loadRecipe("2", NEWLY_REQUIRED_FIELD);
  const blockedPlan = await planRecipeEvolution(bundle, blocked);
  assert.equal(blockedPlan.ready, false);
  await assert.rejects(applyRecipeEvolution(bundle, blocked, blockedPlan.plan_token), (error: unknown) =>
    error instanceof RecipeEvolutionBlocked
    && error.blockers.length === blockedPlan.counts.blockers
    && error.message === `recipe 'widget-workflow' cannot evolve automatically (${blockedPlan.counts.blockers} blockers)`);
  const fields = (await readDoc(bundle, "conventions/widget")).frontmatter.fields as Record<string, unknown>;
  assert.deepEqual(fields.required, ["title"]);
});

/** MemoryBackend that injects one failure into the evolution's convention write when armed. */
class EvolutionFaultBackend extends EditionFlipBackend {
  fault: "race" | "write-policy" | "other" | "edit-after-write" | "fail-reads-after-write" | null = null;
  failReads = false;

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    const fault = id === "conventions/widget" && options.expectedVersion !== undefined ? this.fault : null;
    if (fault !== null) this.fault = null;
    if (fault === "race") {
      const current = await super.read(id);
      await super.write(id, { ...current.doc, body: "# Concurrent winner\n" }, { expectedVersion: current.version });
    }
    if (fault === "write-policy") throw new InvalidInputError("candidate refused by policy");
    if (fault === "other") throw new Error("disk on fire");
    const version = await super.write(id, doc, options);
    if (fault === "edit-after-write") {
      await super.write(id, { ...doc, body: "# Edited after the evolution wrote\n" }, { expectedVersion: version });
    }
    if (fault === "fail-reads-after-write") this.failReads = true;
    return version;
  }

  override async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    if (this.failReads) throw new Error("storage went away");
    return super.readReserved(dir, name);
  }
}

async function armedEvolution(
  name: string,
  arm: (backend: EvolutionFaultBackend) => void,
): Promise<{ bundle: Bundle; run: Promise<unknown> }> {
  const backend = new EvolutionFaultBackend();
  const bundle = await installedWidgetBundle(name, backend);
  const desired = loadRecipe("2", NEW_OPTIONAL_FIELD);
  const plan = await planRecipeEvolution(bundle, desired);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  arm(backend);
  return { bundle, run: applyRecipeEvolution(bundle, desired, plan.plan_token) };
}

test("RecipeEvolutionInterrupted: each reason names the completed and pending definitions", async () => {
  const cases: Array<{ name: string; arm: (backend: EvolutionFaultBackend) => void; reason: string; message: RegExp; cause: (cause: unknown) => boolean }> = [
    {
      name: "race",
      arm: (backend) => { backend.fault = "race"; },
      reason: "race",
      message: /^recipe evolution lost its exact-version race at 'conventions\/widget'; inspect a fresh plan and resume$/,
      cause: (cause) => cause instanceof Error && cause.name === "VersionConflict",
    },
    {
      name: "write_policy",
      arm: (backend) => { backend.fault = "write-policy"; },
      reason: "write_policy",
      message: /^recipe evolution write policy rejected 'conventions\/widget' after preflight: candidate refused by policy$/,
      cause: (cause) => cause instanceof InvalidInputError,
    },
    {
      // The apply's preflight reads the edition once; the next read is the write's own check.
      name: "edition_changed",
      arm: (backend) => { backend.flipAfterReads = 1; },
      reason: "edition_changed",
      message: /^bundle OKF version changed from '0\.2' to '0\.1' during recipe evolution$/,
      cause: (cause) => cause instanceof RecipeEditionChanged && cause.operation === "evolution",
    },
    {
      name: "other",
      arm: (backend) => { backend.fault = "other"; },
      reason: "other",
      message: /^disk on fire$/,
      cause: (cause) => cause instanceof Error && cause.message === "disk on fire",
    },
  ];
  for (const row of cases) {
    const { run } = await armedEvolution(`interrupted-${row.name}`, row.arm);
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof RecipeEvolutionInterrupted, `${row.name}: ${String(error)}`);
      assert.equal(error.reason, row.reason);
      assert.match(error.message, row.message);
      assert.deepEqual(error.completed, []);
      assert.deepEqual(error.pending, ["conventions/widget"]);
      assert.ok(row.cause(error.cause), `${row.name}: cause ${String(error.cause)}`);
      return true;
    });
  }
});

test("RecipeEvolutionPostcondition: an unverifiable or changed re-plan after the writes is reported with them", async () => {
  const unverifiable = await armedEvolution("postcondition-unverifiable", (backend) => { backend.fault = "fail-reads-after-write"; });
  await assert.rejects(unverifiable.run, (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionPostcondition, String(error));
    assert.equal(error.reason, "unverifiable");
    assert.equal(error.message, "recipe evolution wrote 1 definition(s), but its postcondition could not be verified: storage went away");
    assert.deepEqual(error.completed.map(({ id, changed }) => ({ id, changed })), [{ id: "conventions/widget", changed: true }]);
    return true;
  });

  const changed = await armedEvolution("postcondition-changed", (backend) => { backend.fault = "edit-after-write"; });
  await assert.rejects(changed.run, (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionPostcondition, String(error));
    assert.equal(error.reason, "changed");
    assert.equal(error.message, "recipe evolution wrote 1 definition(s), but the prospective registry changed before the postcondition check");
    assert.ok(error.blockers?.some((blocker) => blocker.code === "RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED"));
    assert.match(error.postcondition_plan ?? "", /^sha256:[0-9a-f]{64}$/);
    return true;
  });
});

// ── Recipe install stamps ────────────────────────────────────────────────────────────────────────

type KindFields = { required?: string[]; optional?: string[]; values?: Record<string, string[]> };

function kindDoc(name: string, fields: KindFields = { required: ["title"] }, extra: Record<string, unknown> = {}, body = `# ${name}\n`): OkfDocument {
  return {
    id: `conventions/${name.toLowerCase()}`,
    frontmatter: { type: "Convention", title: name, governs: name, fields, ...extra },
    body,
  };
}

function kindRecipe(id: string, version: string, docs: OkfDocument[]): LoadedRecipe {
  return {
    id,
    title: id,
    version,
    summary: `${id} definitions.`,
    offer: id,
    source: `test:${id}:${version}`,
    docs,
    pages: [],
    references: [],
    governs: docs.map((doc) => String(doc.frontmatter.governs)),
    warnings: [],
  };
}

/** Three Kinds; a version bump that changes only Alpha leaves Beta and Gamma to stamp-only writes. */
const trio = (version: string, alpha: KindFields = { required: ["title"] }, alphaExtra: Record<string, unknown> = {}): LoadedRecipe =>
  kindRecipe("trio", version, [kindDoc("Alpha", alpha, alphaExtra), kindDoc("Beta"), kindDoc("Gamma")]);

const TRIO_IDS = ["conventions/alpha", "conventions/beta", "conventions/gamma"];

/** MemoryBackend that counts writes and injects failures or a concurrent edit when armed. */
class StampProbeBackend extends EditionFlipBackend {
  writes = 0;
  failCreateOf: ConceptId | null = null;
  failCasWriteOf: ConceptId | null = null;
  onFirstCasWrite: ((backend: StampProbeBackend) => Promise<void>) | null = null;
  /** Runs once, after the `count`-th successful CAS write: another writer acting after the apply's writes. */
  afterCasWrites: { count: number; hook: (backend: StampProbeBackend) => Promise<void> } | null = null;

  /** A write outside the counted, armed path: another writer. */
  async rawWrite(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    return super.write(id, doc, options);
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (options.expectedVersion === null && id === this.failCreateOf) {
      this.failCreateOf = null;
      throw new Error("storage refused the create");
    }
    if (typeof options.expectedVersion === "string") {
      const hook = this.onFirstCasWrite;
      this.onFirstCasWrite = null;
      if (hook) await hook(this);
      if (id === this.failCasWriteOf) {
        this.failCasWriteOf = null;
        throw new Error("storage went away");
      }
    }
    this.writes += 1;
    const version = await super.write(id, doc, options);
    if (typeof options.expectedVersion === "string" && this.afterCasWrites) {
      this.afterCasWrites.count -= 1;
      if (this.afterCasWrites.count === 0) {
        const { hook } = this.afterCasWrites;
        this.afterCasWrites = null;
        await hook(this);
      }
    }
    return version;
  }
}

async function probeBundle(name: string): Promise<{ bundle: Bundle; backend: StampProbeBackend }> {
  const backend = new StampProbeBackend();
  return { bundle: await v02Bundle(name, backend), backend };
}

async function conventionsOf(bundle: Bundle, ids: readonly string[] = TRIO_IDS): Promise<OkfDocument[]> {
  return Promise.all(ids.map((id) => readDoc(bundle, id)));
}

async function stateOf(bundle: Bundle, known: readonly LoadedRecipe[] = []) {
  return installedRecipes((await installedConventionDocs(bundle)).values(), known);
}

/** Evolve to `recipe` through a fresh plan and its exact token. */
async function evolve(bundle: Bundle, recipe: LoadedRecipe, actor?: string) {
  const plan = await planRecipeEvolution(bundle, recipe);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  return { plan, applied: await applyRecipeEvolution(bundle, recipe, plan.plan_token, actor ? { actor } : {}) };
}

/** Rewrite one stored convention as another writer would, bypassing the lifecycle. */
async function editConvention(backend: StampProbeBackend, id: ConceptId, change: (doc: OkfDocument) => OkfDocument): Promise<void> {
  const current = await backend.read(id);
  await backend.rawWrite(id, change(structuredClone(current.doc)), { expectedVersion: current.version });
}

/** The same value with object keys reversed at every depth; arrays keep their order. */
const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]))
      : value;
const withFields = (doc: OkfDocument, fields: KindFields): OkfDocument => ({ ...doc, frontmatter: { ...doc.frontmatter, fields } });
const withStamp = (doc: OkfDocument, stamp: unknown): OkfDocument => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: stamp } });
const withoutStamp = (doc: OkfDocument): OkfDocument => {
  const { x_recipe: _stamp, ...frontmatter } = doc.frontmatter;
  return { ...doc, frontmatter: frontmatter as OkfDocument["frontmatter"] };
};

test("T1: installRecipe stamps every created convention, and only conventions", async () => {
  const bundle = await v02Bundle("t1");
  const recipe: LoadedRecipe = {
    ...galleryRecipe("1"),
    references: [{ doc: { id: "references/gallery-guide", frontmatter: { type: "Reference", title: "Gallery guide" }, body: "How to hang.\n" } }],
  };
  const result = await installRecipe(bundle, recipe, { now: NOW });
  assert.equal(result.stamp, "current");
  const convention = await readDoc(bundle, "conventions/exhibit");
  const stamp = convention.frontmatter[RECIPE_STAMP_KEY] as Record<string, unknown>;
  assert.deepEqual(Object.keys(stamp), ["id", "version", "of", "source_digest", "definition", "digest_rules"]);
  assert.deepEqual(stamp, {
    id: "gallery",
    version: "1",
    of: 1,
    source_digest: recipeSourceDigest(recipe),
    definition: definitionDigest(convention),
    digest_rules: DEFINITION_DIGEST_RULES,
  });
  assert.equal(DEFINITION_DIGEST_RULES, 1);
  assert.deepEqual(readRecipeStamp(convention), stamp);
  assert.equal((await readDoc(bundle, "views-registry/gallery")).frontmatter[RECIPE_STAMP_KEY], undefined);
  assert.equal((await readDoc(bundle, "references/gallery-guide")).frontmatter[RECIPE_STAMP_KEY], undefined);
  assert.deepEqual((await stateOf(bundle)).rows, [{
    id: "gallery", state: "installed", version: "1", source_digest: recipeSourceDigest(recipe),
    conventions: 1, of: 1, convention_ids: ["conventions/exhibit"],
  }]);
});

test("T2 (acceptance 1): two bundles upgraded independently, under different clocks and actors, record identical stamps", async (t) => {
  const bundles: Bundle[] = [];
  for (const [index, at] of ["2026-10-14T12:00:00.000Z", "2026-11-30T08:15:00.000Z"].entries()) {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
    const bundle = await v02Bundle(`t2-${index}`);
    await installRecipe(bundle, trio("1"), { now: at });
    const { applied } = await evolve(bundle, trio("2", { required: ["title"], optional: ["colour"] }), index === 0 ? "process:alpha-run" : "human:brian");
    assert.equal(applied.recipe, "evolved");
    assert.deepEqual(applied.counts, { updated: 1, stamped: 2, unchanged: 0 });
    t.mock.timers.reset();
    bundles.push(bundle);
  }
  const [first, second] = await Promise.all(bundles.map((bundle) => conventionsOf(bundle)));
  for (const [index, doc] of first!.entries()) {
    assert.equal(JSON.stringify(doc.frontmatter[RECIPE_STAMP_KEY]), JSON.stringify(second![index]!.frontmatter[RECIPE_STAMP_KEY]), doc.id);
  }
  const [a, b] = await Promise.all(bundles.map((bundle) => stateOf(bundle)));
  assert.deepEqual(a, b);
  assert.deepEqual(a!.rows.map(({ state, version, of, source_digest }) => ({ state, version, of, source_digest })), [
    { state: "installed", version: "2", of: 3, source_digest: recipeSourceDigest(trio("2", { required: ["title"], optional: ["colour"] })) },
  ]);
});

test("T3 (acceptance 2): an idempotent repeat plans no writes and its apply writes nothing", async () => {
  const { bundle, backend } = await probeBundle("t3");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const v2 = trio("2", { required: ["title"], optional: ["colour"] });
  await evolve(bundle, v2);
  const before = await Promise.all(TRIO_IDS.map((id) => backend.read(id)));
  const settled = await planRecipeEvolution(bundle, v2);
  assert.equal(settled.ready, true);
  assert.equal(settled.changed, false);
  assert.equal(settled.writes, 0);
  assert.deepEqual(settled.definitions.map((definition) => definition.stamp), ["current", "current", "current"]);
  backend.writes = 0;
  const repeat = await applyRecipeEvolution(bundle, v2, settled.plan_token);
  assert.equal(repeat.recipe, "already current");
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.counts, { updated: 0, stamped: 0, unchanged: 3 });
  assert.equal(backend.writes, 0);
  assert.deepEqual((await Promise.all(TRIO_IDS.map((id) => backend.read(id)))).map((read) => read.version), before.map((read) => read.version));
  // A second apply of the first plan's token is stale, as before stamps.
  await assert.rejects(applyRecipeEvolution(bundle, v2, "sha256:first-plan"), RecipeEvolutionPlanChanged);
});

test("T4 (acceptance 3, evolve): a stop after two writes reads partial, and a fresh plan converges it", async () => {
  const { bundle, backend } = await probeBundle("t4");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const v2 = trio("2", { required: ["title"], optional: ["colour"] });
  const plan = await planRecipeEvolution(bundle, v2);
  assert.equal(plan.writes, 3);
  backend.failCasWriteOf = "conventions/gamma";
  await assert.rejects(applyRecipeEvolution(bundle, v2, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionInterrupted, String(error));
    assert.equal(error.reason, "other");
    assert.deepEqual(error.completed.map(({ id, changed, stamped }) => ({ id, changed, stamped })), [
      { id: "conventions/alpha", changed: true, stamped: true },
      { id: "conventions/beta", changed: false, stamped: true },
    ]);
    assert.deepEqual(error.pending, ["conventions/gamma"]);
    return true;
  });
  const partial = (await stateOf(bundle)).rows[0]!;
  assert.equal(partial.state, "partial");
  assert.equal(partial.version, null);
  assert.equal(partial.source_digest, null);
  assert.deepEqual(partial.records?.map(({ version, conventions }) => ({ version, conventions })), [
    { version: "1", conventions: 1 },
    { version: "2", conventions: 2 },
  ]);
  const resume = await planRecipeEvolution(bundle, v2);
  assert.equal(resume.writes, 1);
  assert.deepEqual(resume.definitions.map(({ action, stamp }) => `${action}/${stamp}`), ["unchanged/current", "unchanged/current", "unchanged/stale"]);
  const { applied } = await evolve(bundle, v2);
  assert.equal(applied.recipe, "stamped");
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
});

test("T4b (acceptance 3, install): an install stopped after two creates reads partial, and a re-add converges", async () => {
  const { bundle, backend } = await probeBundle("t4b");
  backend.failCreateOf = "conventions/gamma";
  await assert.rejects(installRecipe(bundle, trio("1"), { now: NOW }), /storage refused the create/);
  const { rows } = await stateOf(bundle);
  assert.deepEqual(rows.map(({ state, conventions, of, missing, missing_ids }) => ({ state, conventions, of, missing, missing_ids })), [
    { state: "partial", conventions: 2, of: 3, missing: 1, missing_ids: undefined },
  ]);
  // A known recipe names the missing convention.
  assert.deepEqual((await stateOf(bundle, [trio("1")])).rows[0]!.missing_ids, ["conventions/gamma"]);
  const again = await installRecipe(bundle, trio("1"), { now: NOW });
  assert.deepEqual(again.counts, { created: 1, existing: 2, legacy_present: 0, migration_required: 0 });
  assert.equal(again.stamp, "current");
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
});

test("T4c: a legacy bundle re-adding a version that adds a Kind reads partial until the evolve apply stamps the rest", async () => {
  const { bundle, backend } = await probeBundle("t4c");
  await installRecipe(bundle, trio("1"), { now: NOW });
  for (const id of TRIO_IDS) await editConvention(backend, id, withoutStamp);
  assert.deepEqual((await stateOf(bundle)).unstamped, TRIO_IDS);
  const v2 = kindRecipe("trio", "2", [...trio("1").docs, kindDoc("Delta")]);
  const added = await installRecipe(bundle, v2, { now: NOW });
  assert.equal(added.counts.created, 1);
  assert.equal(added.stamp, "missing");
  const partial = (await stateOf(bundle)).rows[0]!;
  assert.deepEqual([partial.state, partial.conventions, partial.of, partial.missing], ["partial", 1, 4, 3]);
  const { plan, applied } = await evolve(bundle, v2);
  assert.equal(plan.changed, false);
  assert.equal(plan.writes, 3);
  assert.equal(applied.recipe, "stamped");
  const { rows, unstamped } = await stateOf(bundle);
  assert.deepEqual(rows.map(({ state, conventions, of }) => ({ state, conventions, of })), [{ state: "installed", conventions: 4, of: 4 }]);
  assert.deepEqual(unstamped, []);
});

test("T5a (acceptance 4): a local field the next version also declares reads diverged, then installed after the evolve", async () => {
  const { bundle, backend } = await probeBundle("t5a");
  await installRecipe(bundle, trio("1"), { now: NOW });
  await editConvention(backend, "conventions/alpha", (doc) => withFields(doc, { required: ["title"], optional: ["size"] }));
  const diverged = (await stateOf(bundle)).rows[0]!;
  assert.deepEqual([diverged.state, diverged.version, diverged.diverged], ["diverged", "1", ["conventions/alpha"]]);
  const { applied } = await evolve(bundle, trio("2", { required: ["title"], optional: ["size"] }));
  assert.equal(applied.changed, true);
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
});

test("T5b: a local field the next version lacks blocks the plan, writes nothing and stays diverged", async () => {
  const { bundle, backend } = await probeBundle("t5b");
  await installRecipe(bundle, trio("1"), { now: NOW });
  await editConvention(backend, "conventions/alpha", (doc) => withFields(doc, { required: ["title"], optional: ["size"] }));
  const v2 = trio("2", { required: ["title"], optional: ["colour"] });
  const plan = await planRecipeEvolution(bundle, v2);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.blockers.map(({ code, id, field }) => ({ code, id, field })), [
    { code: "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED", id: "conventions/alpha", field: "/frontmatter/fields/optional" },
  ]);
  backend.writes = 0;
  await assert.rejects(applyRecipeEvolution(bundle, v2, plan.plan_token), RecipeEvolutionBlocked);
  assert.equal(backend.writes, 0);
  const row = (await stateOf(bundle)).rows[0]!;
  assert.deepEqual([row.state, row.version, row.diverged], ["diverged", "1", ["conventions/alpha"]]);
});

test("T5c: a locally removed optional field, or enum value, is put back by the next evolve and reads installed", async () => {
  const v1Fields = { required: ["title"], optional: ["setting", "colour"], values: { setting: ["indoor", "outdoor"] } };
  const cases: Array<{ name: string; local: KindFields; added: string }> = [
    { name: "optional field", local: { required: ["title"], optional: ["setting"], values: { setting: ["indoor", "outdoor"] } }, added: "/frontmatter/fields/optional/colour" },
    { name: "enum value", local: { required: ["title"], optional: ["setting", "colour"], values: { setting: ["indoor"] } }, added: "/frontmatter/fields/values/setting/outdoor" },
  ];
  for (const row of cases) {
    const { bundle, backend } = await probeBundle(`t5c-${row.name}`);
    await installRecipe(bundle, trio("1", v1Fields), { now: NOW });
    await editConvention(backend, "conventions/alpha", (doc) => withFields(doc, row.local));
    assert.equal((await stateOf(bundle)).rows[0]!.state, "diverged", row.name);
    const v2 = trio("2", { ...v1Fields, optional: [...v1Fields.optional, "finish"] });
    const plan = await planRecipeEvolution(bundle, v2);
    assert.equal(plan.ready, true, `${row.name}: ${JSON.stringify(plan.blockers)}`);
    assert.ok(plan.definitions[0]!.added_paths.includes(row.added), `${row.name}: ${plan.definitions[0]!.added_paths.join(", ")}`);
    await applyRecipeEvolution(bundle, v2, plan.plan_token);
    assert.equal((await stateOf(bundle)).rows[0]!.state, "installed", row.name);
  }
});

test("T5d: a locally removed required field, or section, blocks the evolve until restored by hand", async () => {
  const v1Extra = { sections: ["Summary"] };
  const v1Fields = { required: ["title", "name"], optional: ["setting"] };
  const cases: Array<{ name: string; edit: (doc: OkfDocument) => OkfDocument; field: string; message: RegExp }> = [
    { name: "required field", edit: (doc) => withFields(doc, { required: ["title"], optional: ["setting"] }), field: "name", message: /cannot newly require 'name'/ },
    {
      name: "section",
      edit: (doc) => {
        const { sections: _sections, ...frontmatter } = doc.frontmatter;
        return { ...doc, frontmatter: frontmatter as OkfDocument["frontmatter"] };
      },
      field: "Summary",
      message: /cannot newly require the '# Summary' section/,
    },
  ];
  for (const row of cases) {
    const { bundle, backend } = await probeBundle(`t5d-${row.name}`);
    await installRecipe(bundle, trio("1", v1Fields, v1Extra), { now: NOW });
    const installed = await backend.read("conventions/alpha");
    await editConvention(backend, "conventions/alpha", row.edit);
    assert.equal((await stateOf(bundle)).rows[0]!.state, "diverged", row.name);
    const v2 = trio("2", { ...v1Fields, optional: ["setting", "colour"] }, v1Extra);
    const plan = await planRecipeEvolution(bundle, v2);
    assert.equal(plan.ready, false, row.name);
    assert.deepEqual(plan.blockers.map(({ code, id, field }) => ({ code, id, field })), [
      { code: "RECIPE_EVOLUTION_NON_MONOTONIC", id: "conventions/alpha", field: row.field },
    ], row.name);
    assert.match(plan.blockers[0]!.message, row.message);
    backend.writes = 0;
    await assert.rejects(applyRecipeEvolution(bundle, v2, plan.plan_token), RecipeEvolutionBlocked);
    assert.equal(backend.writes, 0, row.name);
    assert.equal((await stateOf(bundle)).rows[0]!.state, "diverged", row.name);
    // Restored by hand: the next plan is ready and the evolve reads installed.
    await editConvention(backend, "conventions/alpha", () => installed.doc);
    assert.equal((await stateOf(bundle)).rows[0]!.state, "installed", row.name);
    await evolve(bundle, v2);
    assert.equal((await stateOf(bundle)).rows[0]!.state, "installed", row.name);
  }
});

test("T6: a backfill at the same version writes stamps only and leaves every declaration and body as it was", async () => {
  const { bundle, backend } = await probeBundle("t6");
  await installRecipe(bundle, trio("1"), { now: NOW });
  for (const id of TRIO_IDS) await editConvention(backend, id, withoutStamp);
  const legacy = await conventionsOf(bundle);
  const plan = await planRecipeEvolution(bundle, trio("1"));
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.changed, false);
  assert.equal(plan.writes, 3);
  assert.equal(plan.counts.stamp_writes, 3);
  assert.deepEqual(plan.definitions.map((definition) => definition.stamp), ["missing", "missing", "missing"]);
  const applied = await applyRecipeEvolution(bundle, trio("1"), plan.plan_token);
  assert.equal(applied.recipe, "stamped");
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.counts, { updated: 0, stamped: 3, unchanged: 0 });
  assert.deepEqual(applied.definitions.map(({ changed, stamped }) => ({ changed, stamped })), Array(3).fill({ changed: false, stamped: true }));
  for (const [index, doc] of (await conventionsOf(bundle)).entries()) {
    assert.deepEqual(withoutStamp(doc), legacy[index], doc.id);
    assert.equal(definitionDigest(doc), definitionDigest(legacy[index]!), doc.id);
  }
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
});

test("T7 (red probe): a concurrent edit of an unchanged convention after the apply's preflight loses no work and gains no stamp", async () => {
  const { bundle, backend } = await probeBundle("t7");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const v2 = trio("2", { required: ["title"], optional: ["colour"] });
  const plan = await planRecipeEvolution(bundle, v2);
  assert.deepEqual(plan.definitions.map(({ id, action, stamp }) => `${id}:${action}/${stamp}`), [
    "conventions/alpha:update/stale",
    "conventions/beta:unchanged/stale",
    "conventions/gamma:unchanged/stale",
  ]);
  // On the apply's first CAS write (Alpha's), another writer adds a field to Beta, as `kind field add` would.
  backend.onFirstCasWrite = (probe) =>
    editConvention(probe, "conventions/beta", (doc) => withFields(doc, { required: ["title"], optional: ["size"] }));
  await assert.rejects(applyRecipeEvolution(bundle, v2, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionInterrupted, String(error));
    assert.equal(error.reason, "race");
    assert.match(error.message, /exact-version race at 'conventions\/beta'/);
    assert.deepEqual(error.completed.map(({ id, stamped }) => ({ id, stamped })), [{ id: "conventions/alpha", stamped: true }]);
    assert.deepEqual(error.pending, ["conventions/beta", "conventions/gamma"]);
    return true;
  });
  const [alpha, beta, gamma] = await conventionsOf(bundle);
  assert.equal(readRecipeStamp(alpha!)?.version, "2");
  assert.equal(readRecipeStamp(beta!)?.version, "1", "a write that did not pass its CAS carries no new stamp");
  assert.equal(readRecipeStamp(gamma!)?.version, "1", "a write never attempted carries no new stamp");
  assert.deepEqual((beta!.frontmatter.fields as KindFields).optional, ["size"], "the concurrent edit survives");
  const row = (await stateOf(bundle)).rows[0]!;
  assert.equal(row.state, "partial");
  assert.deepEqual(row.diverged, ["conventions/beta"]);
});

test("T7b: a stamp stripped after the apply's last write fails the postcondition instead of reporting evolved", async () => {
  const { bundle, backend } = await probeBundle("t7b");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const v2 = trio("2", { required: ["title"], optional: ["colour"] });
  const plan = await planRecipeEvolution(bundle, v2);
  assert.equal(plan.writes, 3);
  // After the third and last CAS write, another writer strips Alpha's new stamp.
  backend.afterCasWrites = { count: 3, hook: (probe) => editConvention(probe, "conventions/alpha", withoutStamp) };
  await assert.rejects(applyRecipeEvolution(bundle, v2, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionPostcondition, String(error));
    assert.equal(error.reason, "changed");
    assert.deepEqual(error.completed.map(({ id }) => id), [...TRIO_IDS]);
    assert.match(error.postcondition_plan ?? "", /^sha256:/);
    return true;
  });
  const row = (await stateOf(bundle)).rows[0]!;
  assert.equal(row.state, "partial");
});

test("T8: a stamped install plans no removal and re-adds as already applied, without drift", async () => {
  const bundle = await v02Bundle("t8");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const plan = await planRecipeEvolution(bundle, trio("1"));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.writes, 0);
  const again = await installRecipe(bundle, trio("1"), { now: NOW });
  assert.equal(again.changed, false);
  assert.equal(again.stamp, "current");
  assert.equal(again.counts.source_differs, undefined);
  assert.equal(recipeDrifts(trio("1"), await installedConventionDocs(bundle), "0.2", NOW), false);
  assert.equal((await installRecipe(bundle, trio("2"), { now: NOW })).stamp, "stale");
});

async function exampleRecipe(name: string): Promise<LoadedRecipe> {
  const root = path.resolve(here, "../../../examples/recipes", name);
  const files: Array<{ path: string; bytes: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: await readFile(full, "utf8") });
    }
  };
  await walk(root);
  const loaded = parseRecipeFiles(files, `example:${name}`, { okfVersion: "0.2" });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
  return loaded.recipe;
}

test("T9: the definition digest before the write equals the digest read back, on both backends, LF and CRLF", async () => {
  const nested = kindRecipe("nested", "0.20.0", [
    kindDoc(
      "Ledger",
      { required: ["title"], optional: ["amount", "release"], values: { release: ["0.1", "0.20"] } },
      { x_meta: { schema: { version: "0.20", list: [1, "two", { three: [true, null] }] } }, description: "A ledger, version '0.20'." },
      "# Ledger\r\n\r\nEntries in order.\r\n",
    ),
    kindDoc("Entry", { required: ["title"] }, {}, "# Entry\n\nOne line.\n"),
  ]);
  const recipes = [nested, await exampleRecipe("claims"), await exampleRecipe("review-workflow")];
  const dirs: string[] = [];
  try {
    for (const recipe of recipes) {
      for (const backendName of ["memory", "file-0.2", "file-0.1"]) {
        let bundle: Bundle;
        if (backendName === "memory") bundle = await v02Bundle(`t9-${recipe.id}`);
        else {
          const dir = await mkdtemp(path.join(tmpdir(), "superbee-stamp-digest-"));
          dirs.push(dir);
          bundle = await initBundle(dir, { okfVersion: backendName === "file-0.1" ? "0.1" : "0.2" });
        }
        await installRecipe(bundle, recipe, { now: NOW });
        const label = `${recipe.id} on ${backendName}`;
        const rows = (await stateOf(bundle)).rows;
        assert.deepEqual(rows.map(({ id, state }) => ({ id, state })), [{ id: recipe.id, state: "installed" }], label);
        for (const doc of recipe.docs) {
          const readBack = await readDoc(bundle, doc.id);
          assert.equal(readRecipeStamp(readBack)?.definition, definitionDigest(readBack), `${label}: ${doc.id}`);
        }
        if (backendName === "memory") {
          // The candidate's digest (before the stamp and the write) is the stamp's definition.
          for (const doc of materializeRecipeForEdition(recipe, "0.2").docs) {
            assert.equal(readRecipeStamp(await readDoc(bundle, doc.id))?.definition, definitionDigest(doc), `${label}: ${doc.id} candidate`);
          }
          // Reordering every frontmatter key, at every depth, keeps the same states.
          for (const doc of recipe.docs) {
            const current = await bundle.backend.read(doc.id);
            const frontmatter = reverseKeys(current.doc.frontmatter) as OkfDocument["frontmatter"];
            await bundle.backend.write(doc.id, { ...current.doc, frontmatter }, { expectedVersion: current.version });
          }
          assert.deepEqual((await stateOf(bundle)).rows, rows, `${label}: keys reordered`);
        } else {
          // A CRLF copy of the stamped bundle reads the same states.
          for (const doc of recipe.docs) {
            const file = path.join(bundle.root, `${doc.id}.md`);
            await writeFile(file, (await readFile(file, "utf8")).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
          }
          const reopened = await initBundle(bundle.root);
          assert.match(await readFile(path.join(bundle.root, `${recipe.docs[0]!.id}.md`), "utf8"), /\r\n/);
          assert.deepEqual((await stateOf(reopened)).rows, rows, `${label}: CRLF copy`);
        }
      }
    }
    assert.match(await readFile(path.join(dirs[0]!, "conventions/ledger.md"), "utf8"), /Entries in order\.\r\n/);
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("T10: the source digest covers the parsed content only: not order, line endings or edition", async () => {
  const workflow = kindRecipe("workflow", "1", [
    kindDoc("Job", { required: ["title"], optional: ["progress_status"], values: { progress_status: ["open", "done"] } }),
    kindDoc("Step"),
  ]);
  const digestOf = recipeSourceDigest(workflow);
  assert.match(digestOf, /^sha256:[0-9a-f]{64}$/);
  assert.equal(recipeSourceDigest({ ...workflow, docs: [...workflow.docs].reverse() }), digestOf);
  assert.equal(recipeSourceDigest({ ...workflow, docs: workflow.docs.map((doc) => ({ ...doc, body: doc.body.replaceAll("\n", "\r\n") })) }), digestOf);
  const [job, step] = workflow.docs as [OkfDocument, OkfDocument];
  assert.notEqual(recipeSourceDigest({ ...workflow, docs: [{ ...job, body: `${job.body}.` }, step] }), digestOf);
  assert.notEqual(recipeSourceDigest({ ...workflow, docs: [{ ...job, frontmatter: { ...job.frontmatter, title: "Jobs" } }, step] }), digestOf);
  assert.notEqual(recipeSourceDigest({ ...workflow, version: "2" }), digestOf);
  assert.notEqual(recipeSourceDigest(galleryRecipe("1")), recipeSourceDigest(galleryRecipe("1", [], "<p>other</p>\n")));
  // Equal across editions: the stamp's digest is taken before the workflow field is materialized.
  const stamps: unknown[] = [];
  const dirs: string[] = [];
  try {
    for (const okfVersion of ["0.1", "0.2"] as const) {
      const dir = await mkdtemp(path.join(tmpdir(), "superbee-stamp-source-"));
      dirs.push(dir);
      const bundle = await initBundle(dir, { okfVersion });
      await installRecipe(bundle, workflow, { now: NOW });
      stamps.push(readRecipeStamp(await readDoc(bundle, "conventions/job"))?.source_digest);
    }
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
  assert.deepEqual(stamps, [digestOf, digestOf]);
});

test("T15: a convention another recipe owns reads foreign, is never rewritten for its stamp alone, and leaves its recipe partial", async () => {
  const shared = kindDoc("Shared");
  const recipeA = (version: string) => kindRecipe("recipe-a", version, [kindDoc("Apple"), shared]);
  const recipeB = (version: string) => kindRecipe("recipe-b", version, [shared, kindDoc("Banana")]);
  const { bundle, backend } = await probeBundle("t15");
  await installRecipe(bundle, recipeB("1"), { now: NOW });
  await installRecipe(bundle, recipeA("1"), { now: NOW });
  const planA = await planRecipeEvolution(bundle, recipeA("2"));
  assert.deepEqual(planA.definitions.map(({ id, stamp }) => `${id}:${stamp}`), ["conventions/apple:stale", "conventions/shared:foreign"]);
  assert.equal(planA.writes, 1);
  await applyRecipeEvolution(bundle, recipeA("2"), planA.plan_token);
  await evolve(bundle, recipeB("2"));
  backend.writes = 0;
  for (const recipe of [recipeA("2"), recipeB("2"), recipeA("2")]) {
    const { plan, applied } = await evolve(bundle, recipe);
    assert.equal(plan.writes, 0, recipe.id);
    assert.equal(applied.recipe, "already current", recipe.id);
  }
  assert.equal(backend.writes, 0, "no ping-pong after the first pass");
  const { rows } = await stateOf(bundle, [recipeA("2"), recipeB("2")]);
  assert.deepEqual(rows.map(({ id, state, missing_ids }) => ({ id, state, missing_ids })), [
    { id: "recipe-a", state: "partial", missing_ids: ["conventions/shared"] },
    { id: "recipe-b", state: "installed", missing_ids: undefined },
  ]);
});

test("T16: unknown digest rules read unknown, never diverged; a tampered definition reads diverged; other tampering reads stale", async () => {
  const { bundle, backend } = await probeBundle("t16");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const stampOf = async (id: ConceptId) => readRecipeStamp(await readDoc(bundle, id))!;
  const original = await stampOf("conventions/alpha");
  await editConvention(backend, "conventions/alpha", (doc) => withStamp(withFields(doc, { required: ["title"], optional: ["size"] }), { ...original, digest_rules: 2 }));
  let row = (await stateOf(bundle)).rows[0]!;
  assert.deepEqual([row.state, row.unknown_rules, row.diverged], ["unknown", ["conventions/alpha"], undefined]);
  assert.equal(row.version, null);

  await editConvention(backend, "conventions/alpha", (doc) => withStamp(withFields(doc, { required: ["title"] }), original));
  const beta = await stampOf("conventions/beta");
  await editConvention(backend, "conventions/beta", (doc) => withStamp(doc, { ...beta, definition: `sha256:${"0".repeat(64)}` }));
  row = (await stateOf(bundle)).rows[0]!;
  assert.deepEqual([row.state, row.diverged], ["diverged", ["conventions/beta"]]);
  // Beta's content still equals what the recipe writes, so a same-version plan re-stamps it.
  const repair = await planRecipeEvolution(bundle, trio("1"));
  assert.equal(repair.definitions.find((definition) => definition.id === "conventions/beta")?.stamp, "stale");
  assert.equal(repair.writes, 1);
  await applyRecipeEvolution(bundle, trio("1"), repair.plan_token);
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
  assert.equal((await planRecipeEvolution(bundle, trio("1"))).writes, 0);

  for (const tamper of [{ version: "0" }, { of: 4 }, { source_digest: `sha256:${"1".repeat(64)}` }]) {
    const gamma = await stampOf("conventions/gamma");
    await editConvention(backend, "conventions/gamma", (doc) => withStamp(doc, { ...gamma, ...tamper }));
    const plan = await planRecipeEvolution(bundle, trio("1"));
    assert.equal(plan.definitions.find((definition) => definition.id === "conventions/gamma")?.stamp, "stale", JSON.stringify(tamper));
    await editConvention(backend, "conventions/gamma", (doc) => withStamp(doc, gamma));
  }
});

test("T17: a malformed stamp reads missing, is listed unstamped, and the next apply rewrites it without a crash", async () => {
  const malformed: Array<[string, (stamp: RecipeStampShape) => unknown]> = [
    ["a string", () => "trio"],
    ["a list", (stamp) => [stamp]],
    ["a missing field", ({ definition: _definition, ...rest }) => rest],
    ["a non-integer of", (stamp) => ({ ...stamp, of: 2.5 })],
  ];
  for (const [name, corrupt] of malformed) {
    const { bundle, backend } = await probeBundle(`t17-${name}`);
    await installRecipe(bundle, trio("1"), { now: NOW });
    const stamp = readRecipeStamp(await readDoc(bundle, "conventions/alpha"))!;
    await editConvention(backend, "conventions/alpha", (doc) => withStamp(doc, corrupt(stamp)));
    assert.equal(readRecipeStamp(await readDoc(bundle, "conventions/alpha")), null, name);
    const before = await stateOf(bundle);
    assert.deepEqual(before.unstamped, ["conventions/alpha"], name);
    assert.equal(before.rows[0]!.state, "partial", name);
    const { plan } = await evolve(bundle, trio("1"));
    assert.equal(plan.definitions[0]!.stamp, "missing", name);
    assert.equal(plan.writes, 1, name);
    const after = await stateOf(bundle);
    assert.deepEqual([after.rows[0]!.state, after.unstamped], ["installed", []], name);
  }
});

type RecipeStampShape = NonNullable<ReturnType<typeof readRecipeStamp>>;

test("installedRecipes: a known recipe gets a row from a stamp or an unstamped declaring convention, never from a declined Kind or another recipe's stamp", async () => {
  const declined: OkfDocument = {
    id: "conventions/beta",
    frontmatter: { type: "Convention", title: "Beta", governs: "Beta", description: "Declined: 'Beta' is deliberately unconstrained (recorded by 'kind dismiss')." },
    body: "Declined.\n",
  };
  const owned = withStamp(kindDoc("Gamma"), { id: "other", version: "1", of: 1, source_digest: "sha256:x", definition: definitionDigest(kindDoc("Gamma")), digest_rules: 1 });
  const onlyBeta = kindRecipe("only-beta", "1", [kindDoc("Beta")]);
  const onlyGamma = kindRecipe("only-gamma", "1", [kindDoc("Gamma")]);
  const legacyAlpha = kindRecipe("legacy-alpha", "1", [kindDoc("Alpha")]);
  const read = installedRecipes([kindDoc("Alpha"), declined, owned, { id: "conventions/readme", frontmatter: { type: "Reference" }, body: "" }], [onlyBeta, onlyGamma, legacyAlpha]);
  assert.deepEqual(read.rows.map(({ id, state, conventions, of }) => ({ id, state, conventions, of })), [
    { id: "legacy-alpha", state: "unknown", conventions: 0, of: 1 },
    { id: "other", state: "installed", conventions: 1, of: 1 },
  ]);
  assert.deepEqual(read.unstamped, ["conventions/alpha"], "a declaration-free record and a non-Convention document are never unstamped");
});
