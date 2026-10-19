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
import { readBlob, readBundleOkfVersion, readDoc, writeBlob, writeDoc } from "../src/bundle-ops.js";
import { InvalidInputError } from "../src/errors.js";
import { parseConventionDoc } from "../src/kinds.js";
import { kindInstanceCandidate } from "../src/kind-authoring.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RECIPE_FILES } from "./fixtures/connectors/example-calendar.js";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipes.js";
import type { Bundle, ConceptId, OkfDocument, ReservedFilename, ReservedReadResult, Version, WriteOptions } from "../src/types.js";
import {
  applyRecipeEvolution,
  DEFINITION_DIGEST_RULES,
  definitionDigest,
  installRecipe,
  prepareRecipeInstall,
  inspectRecipeInstallTarget,
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
    assert.equal(error.message, "recipe evolution wrote 1 definition(s), but the bundle changed (a definition or its stamp) before the postcondition check; a fresh recipe evolve plan shows the current state");
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

test("T1: installRecipe stamps conventions and References, leaving View registries unstamped", async () => {
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
  assert.equal(readRecipeStamp(await readDoc(bundle, "references/gallery-guide"))?.definition, definitionDigest(await readDoc(bundle, "references/gallery-guide")));
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
  // A local duplicate is a real edit: evolution preserves it and blocks removing its occurrence.
  // It stays diverged and plans no write at the current recipe identity.
  await editConvention(backend, "conventions/beta", (doc) => {
    const fields = doc.frontmatter.fields as KindFields;
    return withFields(doc, { ...fields, required: [...(fields.required ?? []), ...(fields.required ?? [])] });
  });
  const reordered = await planRecipeEvolution(bundle, trio("1"));
  assert.equal(reordered.definitions.find((definition) => definition.id === "conventions/beta")?.stamp, "current");
  assert.equal(reordered.writes, 0);
  assert.deepEqual((await stateOf(bundle)).rows[0]!.diverged, ["conventions/beta"]);

  for (const tamper of [{ version: "0" }, { of: 4 }, { source_digest: `sha256:${"1".repeat(64)}` }]) {
    const gamma = await stampOf("conventions/gamma");
    await editConvention(backend, "conventions/gamma", (doc) => withStamp(doc, { ...gamma, ...tamper }));
    const plan = await planRecipeEvolution(bundle, trio("1"));
    assert.equal(plan.definitions.find((definition) => definition.id === "conventions/gamma")?.stamp, "stale", JSON.stringify(tamper));
    await editConvention(backend, "conventions/gamma", (doc) => withStamp(doc, gamma));
  }
});

test("T16b: a known recipe with a declared convention renamed away reads partial and names it, even with the count padded", async () => {
  const { bundle, backend } = await probeBundle("t16b");
  await installRecipe(bundle, trio("1"), { now: NOW });
  const beta = await backend.read("conventions/beta");
  await backend.rawWrite("conventions/beta-renamed", { ...beta.doc, id: "conventions/beta-renamed" }, { expectedVersion: null });
  await backend.delete("conventions/beta", { expectedVersion: beta.version });
  const known = (await stateOf(bundle, [trio("1")])).rows[0]!;
  assert.equal(known.state, "partial");
  assert.deepEqual(known.missing_ids, ["conventions/beta"]);
  // Without the recipe the reader only has the count, which the renamed copy still satisfies.
  assert.equal((await stateOf(bundle)).rows[0]!.state, "installed");
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

// Field-description evolution: whole-definition ownership and exact-plan writes.

const DESCRIPTION_FIELD = "topic/~order";
const DESCRIPTION_POINTER = "/frontmatter/fields/descriptions/topic~1~0order";

function descriptionRecipe(version: string, guidance: string, ids = ["conventions/widget"]): LoadedRecipe {
  return {
    id: "description-fixture", title: "Description fixture", version,
    summary: "Field guidance.", offer: "Field guidance.", source: `test:descriptions:${version}`,
    docs: ids.map((id, index) => ({
      id, frontmatter: {
        type: "Convention", title: `Widget${index}`, governs: `Widget${index}`,
        fields: { required: ["title"], optional: [DESCRIPTION_FIELD], descriptions: { [DESCRIPTION_FIELD]: guidance } },
      }, body: "# Guidance\n",
    })), pages: [], references: [], governs: ids.map((_, index) => `Widget${index}`), warnings: [],
  };
}

class DescriptionProbeBackend extends MemoryBackend {
  writes = 0;
  beforeCas: (() => Promise<void>) | null = null;
  failId: string | null = null;
  flipEdition = false;
  editionReads = 0;

  override async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    const result = await super.readReserved(dir, name);
    if (this.flipEdition && name === "index.md" && ++this.editionReads > 1 && result) {
      return { ...result, content: "---\nokf_version: '0.1'\n---\n" };
    }
    return result;
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (typeof options.expectedVersion === "string") {
      const hook = this.beforeCas;
      this.beforeCas = null;
      if (hook) await hook();
      if (id === this.failId) {
        this.failId = null;
        throw new Error("interrupted fixture");
      }
    }
    const version = await super.write(id, doc, options);
    this.writes++;
    return version;
  }

  async edit(id: string, change: (doc: OkfDocument) => OkfDocument): Promise<void> {
    const current = await super.read(id);
    await super.write(id, change(current.doc), { expectedVersion: current.version });
  }
}

async function descriptionFixture(edition = "0.2", ids?: string[]): Promise<{ bundle: Bundle; backend: DescriptionProbeBackend }> {
  const backend = new DescriptionProbeBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  const bundle: Bundle = { root: "mem://description-evolution", backend };
  await installRecipe(bundle, descriptionRecipe("1", "Old guidance", ids), { now: NOW });
  backend.writes = 0;
  return { bundle, backend };
}

function descriptionGuidance(doc: OkfDocument): unknown {
  return (doc.frontmatter.fields as { descriptions: Record<string, unknown> }).descriptions[DESCRIPTION_FIELD];
}

function editedDescriptionGuidance(doc: OkfDocument, text: unknown): OkfDocument {
  const fields = doc.frontmatter.fields as { descriptions: Record<string, unknown> };
  return { ...doc, frontmatter: { ...doc.frontmatter, fields: { ...fields, descriptions: { ...fields.descriptions, [DESCRIPTION_FIELD]: text } } } };
}

test("description evolution: both editions plan explicit old/new guidance, preserve placement, apply and settle without writes", async () => {
  for (const edition of ["0.1", "0.2"]) {
    const { bundle, backend } = await descriptionFixture(edition);
    await backend.edit("conventions/widget", (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, order: 3 } }));
    const desired = descriptionRecipe("2", "First topic is primary");
    const fields = desired.docs[0]!.frontmatter.fields as { optional: string[]; descriptions: Record<string, string> };
    fields.optional.push("colour");
    fields.descriptions.colour = "An optional colour";
    const before = await readDoc(bundle, "conventions/widget");
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.equal(backend.writes, 0, "planning is read-only");
    assert.deepEqual(await readDoc(bundle, "conventions/widget"), before);
    assert.deepEqual(plan.definitions[0]!.description_replacements, [{ path: DESCRIPTION_POINTER, old: "Old guidance", new: "First topic is primary" }]);
    assert.deepEqual(plan.definitions[0]!.added_paths, ["/frontmatter/fields/descriptions/colour", "/frontmatter/fields/optional/colour"]);
    const applied = await applyRecipeEvolution(bundle, desired, plan.plan_token, { actor: "process:description-test" });
    assert.deepEqual(applied.counts, { updated: 1, stamped: 0, unchanged: 0 });
    const written = await readDoc(bundle, "conventions/widget");
    assert.equal(descriptionGuidance(written), "First topic is primary");
    assert.equal(written.frontmatter.order, 3);
    assert.equal(readRecipeStamp(written)?.version, "2");
    assert.equal(await readBundleOkfVersion(bundle), edition);
    const settled = await planRecipeEvolution(bundle, desired);
    assert.equal(settled.ready, true);
    assert.equal(settled.changed, false);
    assert.equal(settled.writes, 0);
    assert.equal(Object.hasOwn(settled.definitions[0]!, "description_replacements"), false);
    backend.writes = 0;
    assert.equal((await applyRecipeEvolution(bundle, desired, settled.plan_token)).recipe, "already current");
    assert.equal(backend.writes, 0);
  }
});

test("description evolution: local edits and unproved baselines block replacements and keep exact bytes", async () => {
  const cases: Array<{ name: string; change: (doc: OkfDocument) => OkfDocument }> = [
    { name: "local guidance", change: (doc) => editedDescriptionGuidance(doc, "My guidance") },
    { name: "unrelated local edit", change: (doc) => ({ ...doc, body: "# Local body\n" }) },
    { name: "missing stamp", change: (doc) => { const { x_recipe: _stamp, ...frontmatter } = doc.frontmatter; return { ...doc, frontmatter }; } },
    { name: "malformed stamp", change: (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: { id: "description-fixture" } } }) },
    { name: "foreign stamp", change: (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: { ...readRecipeStamp(doc)!, id: "other-recipe" } } }) },
    { name: "unknown rules", change: (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: { ...readRecipeStamp(doc)!, digest_rules: 999 } } }) },
  ];
  for (const row of cases) {
    const { bundle, backend } = await descriptionFixture();
    await backend.edit("conventions/widget", row.change);
    const before = await backend.read("conventions/widget");
    const desired = descriptionRecipe("2", "New guidance");
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, false, row.name);
    assert.ok(plan.blockers.some((blocker) => blocker.code === "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED" && blocker.field === DESCRIPTION_POINTER), row.name);
    assert.equal(plan.definitions[0]!.description_replacements, undefined, row.name);
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionBlocked);
    assert.deepEqual(await backend.read("conventions/widget"), before, row.name);
    assert.equal(backend.writes, 0, row.name);
  }
});

test("description evolution: removals and schema replacements retain their blockers", async () => {
  for (const change of ["remove", "schema"] as const) {
    const { bundle } = await descriptionFixture();
    const desired = descriptionRecipe("2", "New guidance");
    if (change === "remove") delete (desired.docs[0]!.frontmatter.fields as { descriptions?: unknown }).descriptions;
    else desired.docs[0]!.frontmatter.path = "changed/";
    if (change === "schema") {
      const before = await readDoc(bundle, "conventions/widget");
      // An existing semantic scalar cannot be replaced under the guidance exception.
      const backend = bundle.backend as DescriptionProbeBackend;
      await backend.edit("conventions/widget", (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, path: "original/" } }));
      assert.equal(descriptionGuidance(before), "Old guidance");
    }
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, false);
    assert.ok(plan.blockers.some((blocker) => change === "remove"
      ? blocker.code === "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED"
      : blocker.code === "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED" && blocker.field === "/frontmatter/path"));
  }
});

test("description evolution: source or installed edits after planning refuse the stale token without writing", async () => {
  for (const changed of ["source", "installed"] as const) {
    const { bundle, backend } = await descriptionFixture();
    const desired = descriptionRecipe("2", "New guidance");
    const plan = await planRecipeEvolution(bundle, desired);
    if (changed === "source") desired.docs[0] = editedDescriptionGuidance(desired.docs[0]!, "Changed source guidance");
    else await backend.edit("conventions/widget", (doc) => editedDescriptionGuidance(doc, "Concurrent guidance"));
    const before = await backend.read("conventions/widget");
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionPlanChanged);
    assert.deepEqual(await backend.read("conventions/widget"), before);
    assert.equal(backend.writes, 0);
  }
});

test("description evolution: a post-preflight edit loses the exact CAS race and preserves the winner", async () => {
  const { bundle, backend } = await descriptionFixture();
  const desired = descriptionRecipe("2", "New guidance");
  const plan = await planRecipeEvolution(bundle, desired);
  backend.beforeCas = async () => backend.edit("conventions/widget", (doc) => editedDescriptionGuidance(doc, "Concurrent winner"));
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionInterrupted);
    assert.equal(error.reason, "race");
    assert.deepEqual(error.completed, []);
    assert.deepEqual(error.pending, ["conventions/widget"]);
    return true;
  });
  assert.equal(descriptionGuidance(await readDoc(bundle, "conventions/widget")), "Concurrent winner");
  assert.equal(readRecipeStamp(await readDoc(bundle, "conventions/widget"))?.version, "1");
  assert.equal(backend.writes, 0);
});

test("description evolution: edition changes interrupt before the description write", async () => {
  const { bundle, backend } = await descriptionFixture();
  const desired = descriptionRecipe("2", "New guidance");
  const plan = await planRecipeEvolution(bundle, desired);
  backend.flipEdition = true;
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => error instanceof RecipeEvolutionInterrupted && error.reason === "edition_changed");
  assert.equal(backend.writes, 0);
  assert.equal(descriptionGuidance(await readDoc(bundle, "conventions/widget")), "Old guidance");
});

test("description evolution: interrupted multi-definition apply reports progress and a fresh retry converges", async () => {
  const ids = ["conventions/alpha", "conventions/beta"];
  const { bundle, backend } = await descriptionFixture("0.2", ids);
  const desired = descriptionRecipe("2", "New guidance", ids);
  const plan = await planRecipeEvolution(bundle, desired);
  backend.failId = ids[1]!;
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionInterrupted);
    assert.deepEqual(error.completed.map(({ id, changed }) => ({ id, changed })), [{ id: ids[0], changed: true }]);
    assert.deepEqual(error.pending, [ids[1]]);
    return true;
  });
  assert.equal(descriptionGuidance(await readDoc(bundle, ids[0]!)), "New guidance");
  assert.equal(descriptionGuidance(await readDoc(bundle, ids[1]!)), "Old guidance");
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionPlanChanged);
  const retry = await planRecipeEvolution(bundle, desired);
  assert.equal(retry.ready, true);
  assert.equal(retry.writes, 1);
  assert.deepEqual((await applyRecipeEvolution(bundle, desired, retry.plan_token)).counts, { updated: 1, stamped: 0, unchanged: 1 });
  assert.equal((await planRecipeEvolution(bundle, desired)).writes, 0);
});

// Actor-aware installation: mutation attribution is local; recipe provenance remains upstream.
test("install actor: attributed new definitions preserve upstream provenance and repeat across actors without drift", async () => {
  for (const edition of ["0.1", "0.2"] as const) {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
    const bundle: Bundle = { root: `mem://install-actor-${edition}`, backend };
    const recipe = galleryRecipe("1");
    recipe.docs[0]!.frontmatter.generated = { by: "human:recipe-author", at: NOW };
    recipe.docs[0]!.frontmatter.x_upstream = { retained: true };
    recipe.references = [{ doc: { id: "references/gallery", frontmatter: { type: "Reference", title: "Gallery guide" }, body: "Guide.\n" } }];
    const sourceDigest = recipeSourceDigest(recipe);
    const actor = edition === "0.2" ? "process:installer-one" : "Legacy installer";
    const first = await installRecipe(bundle, recipe, { now: NOW, actor });
    assert.equal(first.changed, true);
    const before = new Map<string, Awaited<ReturnType<typeof backend.read>>>();
    for (const id of ["conventions/exhibit", "views-registry/gallery", "references/gallery"]) {
      const read = await backend.read(id);
      before.set(id, read);
      assert.equal(read.doc.frontmatter[edition === "0.2" ? "superbee_updated_by" : "actor"], actor);
    }
    const installed = await readDoc(bundle, "conventions/exhibit");
    assert.deepEqual(installed.frontmatter.generated, recipe.docs[0]!.frontmatter.generated);
    assert.deepEqual(installed.frontmatter.x_upstream, { retained: true });
    assert.equal((await readDoc(bundle, "references/gallery")).frontmatter.generated, undefined, "installation does not manufacture a content producer");
    assert.equal(recipeSourceDigest(recipe), sourceDigest);
    assert.equal(readRecipeStamp(installed)!.source_digest, sourceDigest);
    assert.equal(readRecipeStamp(installed)!.definition, definitionDigest(installed));
    const again = await installRecipe(bundle, recipe, { now: "2026-10-19T12:00:00.000Z", actor: "process:installer-two" });
    assert.equal(again.changed, false);
    assert.equal(again.counts.source_differs, undefined);
    assert.equal(again.stamp, "current");
    for (const [id, read] of before) assert.deepEqual(await backend.read(id), read, "repeat add never rewrites an existing document or its actor");
    assert.equal(recipeDrifts(recipe, new Map([[installed.id, installed]]), edition, NOW), false);
    assert.equal(installedRecipes([installed], [recipe]).rows[0]!.state, "installed");
    const changedSource = galleryRecipe("1");
    changedSource.docs[0]!.frontmatter = { ...recipe.docs[0]!.frontmatter, generated: { by: "human:different-producer", at: NOW } };
    const drift = await installRecipe(bundle, changedSource, { actor: "process:installer-three" });
    assert.equal(drift.docs[0]!.source_differs, true, "a different upstream producer remains real source drift");
    assert.deepEqual(await backend.read("conventions/exhibit"), before.get("conventions/exhibit"));
  }
});

test("install actor: invalid v0.2 attribution refuses before documents or an asset-only recipe writes", async () => {
  for (const assetsOnly of [false, true]) {
    const backend = new MemoryBackend();
    const bundle = await v02Bundle(`invalid-install-actor-${assetsOnly}`, backend);
    let writes = 0;
    const write = backend.write.bind(backend), writeBlob = backend.writeBlob.bind(backend);
    backend.write = (...args: Parameters<MemoryBackend["write"]>) => { writes++; return write(...args); };
    backend.writeBlob = (...args: Parameters<MemoryBackend["writeBlob"]>) => { writes++; return writeBlob(...args); };
    const recipe = galleryRecipe("1");
    if (assetsOnly) { recipe.docs = []; recipe.governs = []; }
    await assert.rejects(installRecipe(bundle, recipe, { actor: "unqualified actor" }), { name: "OkfActorError" });
    assert.equal(writes, 0);
    assert.deepEqual(await backend.list(), []);
    assert.deepEqual(await backend.listBlobs(), []);
  }
});

// Reference evolution: explicit ownership, separate rows, one shared CAS/recovery protocol.
function referenceRecipe(version = "1", body = "Original guide.\n", ids = ["references/guide"]): LoadedRecipe {
  return {
    id: "reference-fixture", title: "Reference fixture", version, summary: "Guides.", offer: "Guides.", source: `test:references:${version}`,
    docs: [], pages: [], governs: [], warnings: [],
    references: ids.map(id => ({ doc: { id, frontmatter: { type: "Reference", title: "Guide", generated: { by: "upstream/author", at: NOW } }, body } })),
  };
}
async function referenceFixture(edition = "0.2", ids?: string[]) {
  const backend = new DescriptionProbeBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  const bundle: Bundle = { root: "mem://reference-evolution", backend };
  const recipe = referenceRecipe("1", undefined, ids);
  await installRecipe(bundle, recipe, { now: NOW, actor: "process:reference-installer" });
  backend.writes = 0;
  return { bundle, backend, recipe };
}
function withoutReferenceStamp(doc: OkfDocument): OkfDocument {
  const { x_recipe: _stamp, ...frontmatter } = doc.frontmatter;
  return { ...doc, frontmatter };
}

test("Reference evolution: reference-only recipes stamp, replace and settle in both editions without changing definition counts", async () => {
  for (const edition of ["0.1", "0.2"]) {
    const { bundle, backend, recipe } = await referenceFixture(edition);
    const installed = await readDoc(bundle, "references/guide");
    assert.equal(readRecipeStamp(installed)?.definition, definitionDigest(installed));
    assert.deepEqual(installedRecipes([installed]).rows, [], "existing receipt projection remains convention/Connector-only");
    const before = await backend.read(installed.id);
    assert.equal((await installRecipe(bundle, recipe, { actor: "process:other-installer" })).changed, false);
    assert.deepEqual(await backend.read(installed.id), before);
    await backend.edit(installed.id, doc => ({ ...doc, frontmatter: { ...doc.frontmatter, order: 8 } }));
    const desired = referenceRecipe("2", "Updated guide.\n");
    desired.references[0]!.doc.frontmatter.title = "Updated title";
    desired.references[0]!.doc.frontmatter.generated = { by: "source/changed", at: "2026-10-19T12:00:00Z" };
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.equal(plan.changed, true);
    assert.equal(plan.writes, 1);
    assert.deepEqual(plan.definitions, []);
    assert.equal(plan.counts.definitions, 0);
    assert.equal(plan.counts.updates, 0);
    assert.deepEqual(plan.reference_assets!.counts, { updates: 1, stamp_writes: 0, unchanged: 0, missing: 0 });
    assert.equal(backend.writes, 0, "plan has no writes");
    const applied = await applyRecipeEvolution(bundle, desired, plan.plan_token, { actor: "process:reference-evolver" });
    assert.equal(applied.recipe, "evolved");
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.counts, { updated: 0, stamped: 0, unchanged: 0 });
    assert.equal(applied.reference_assets!.rows[0]!.asset_kind, "reference");
    assert.deepEqual(applied.reference_assets!.counts, { updated: 1, stamped: 0, unchanged: 0 });
    const written = await readDoc(bundle, installed.id);
    assert.equal(written.body, "Updated guide.\n");
    assert.equal(written.frontmatter.title, "Updated title");
    assert.equal(written.frontmatter.order, 8);
    assert.equal((written.frontmatter.generated as { by: string }).by, "upstream/author");
    assert.equal(written.frontmatter[edition === "0.2" ? "superbee_updated_by" : "actor"], "process:reference-evolver");
    assert.equal(readRecipeStamp(written)?.version, "2");
    assert.equal(readRecipeStamp(written)?.definition, definitionDigest(written));
    const settled = await planRecipeEvolution(bundle, desired);
    assert.equal(settled.ready, true);
    assert.equal(settled.writes, 0);
    backend.writes = 0;
    assert.equal((await applyRecipeEvolution(bundle, desired, settled.plan_token)).recipe, "already current");
    assert.equal(backend.writes, 0);
  }
});

test("Reference evolution: exact-source unstamped adoption establishes ownership now, then a later release can update", async () => {
  for (const edition of ["0.1", "0.2"]) {
    const { bundle, backend, recipe } = await referenceFixture(edition);
    await backend.edit("references/guide", withoutReferenceStamp);
    const before = await readDoc(bundle, "references/guide");
    const plan = await planRecipeEvolution(bundle, recipe);
    assert.equal(plan.ready, true);
    assert.equal(plan.changed, false);
    assert.equal(plan.writes, 1);
    assert.deepEqual(plan.reference_assets!.counts, { updates: 0, stamp_writes: 1, unchanged: 1, missing: 0 });
    const applied = await applyRecipeEvolution(bundle, recipe, plan.plan_token, { actor: "process:adopter" });
    assert.equal(applied.recipe, "stamped");
    assert.equal(applied.reference_assets!.counts.stamped, 1);
    assert.equal((await readDoc(bundle, "references/guide")).body, before.body);
    const desired = referenceRecipe("2", "Later guide.\n");
    const next = await planRecipeEvolution(bundle, desired);
    assert.equal(next.ready, true);
    await applyRecipeEvolution(bundle, desired, next.plan_token);
    assert.equal((await readDoc(bundle, "references/guide")).body, "Later guide.\n");
    assert.ok(backend.writes > 0);
  }
});

test("Reference evolution: legacy differences, foreign or malformed stamps, unknown rules and substantive local edits never gain ownership", async () => {
  const cases: Array<{ name: string; change: (doc: OkfDocument) => OkfDocument }> = [
    { name: "differing legacy", change: doc => ({ ...withoutReferenceStamp(doc), body: "Legacy guide.\n" }) },
    { name: "foreign identical content", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: { ...readRecipeStamp(doc)!, id: "another-recipe" } } }) },
    { name: "malformed identical content", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: null } }) },
    { name: "empty stamp", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: {} } }) },
    { name: "array stamp", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: [] } }) },
    { name: "wrong installed type", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, type: "Note" } }) },
    { name: "unknown rules", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_recipe: { ...readRecipeStamp(doc)!, digest_rules: 999 } } }) },
    { name: "local body", change: doc => ({ ...doc, body: "Person's guide.\n" }) },
    { name: "local metadata", change: doc => ({ ...doc, frontmatter: { ...doc.frontmatter, title: "My title" } }) },
    { name: "adoption with different upstream provenance", change: doc => ({ ...withoutReferenceStamp(doc), frontmatter: { ...withoutReferenceStamp(doc).frontmatter, generated: { by: "person/author", at: NOW } } }) },
  ];
  for (const edition of ["0.1", "0.2"]) for (const row of cases) {
    const { bundle, backend, recipe } = await referenceFixture(edition);
    await backend.edit("references/guide", row.change);
    const before = await backend.read("references/guide");
    // Equal desired content must not turn an invalid/foreign stamp into an absent baseline.
    const plan = await planRecipeEvolution(bundle, recipe);
    assert.equal(plan.ready, false, row.name);
    assert.ok(plan.blockers.some(b => b.code === "RECIPE_EVOLUTION_REFERENCE_UNPROVEN"), row.name);
    await assert.rejects(applyRecipeEvolution(bundle, recipe, plan.plan_token), RecipeEvolutionBlocked);
    assert.equal(backend.writes, 0, row.name);
    assert.deepEqual(await backend.read("references/guide"), before, row.name);
  }
});

test("Reference evolution: missing assets remain add-first and View changes are still refused", async () => {
  const { bundle } = await referenceFixture();
  const missing = referenceRecipe("2", "New.\n", ["references/new"]);
  const plan = await planRecipeEvolution(bundle, missing);
  assert.equal(plan.ready, false);
  assert.equal(plan.reference_assets!.rows[0]!.action, "missing");
  assert.ok(plan.blockers.some(b => b.code === "RECIPE_EVOLUTION_ASSET_MISSING"));
  const viewBundle = await v02Bundle("reference-view");
  const withViews = { ...galleryRecipe("1"), references: referenceRecipe().references };
  await installRecipe(viewBundle, withViews);
  const changedView = structuredClone(withViews);
  changedView.pages[0]!.html += "changed";
  assert.equal((await planRecipeEvolution(viewBundle, changedView)).ready, false);
});

test("Reference evolution: source, stamp, local bytes or edition changes invalidate the exact observed token", async () => {
  for (const change of ["source", "stamp", "content", "edition"]) {
    const { bundle, backend } = await referenceFixture();
    const desired = referenceRecipe("2", "New.\n");
    const plan = await planRecipeEvolution(bundle, desired);
    if (change === "source") desired.references[0]!.doc.body = "Different source.\n";
    else if (change === "edition") await backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
    else await backend.edit("references/guide", doc => change === "content" ? { ...doc, body: "Winner.\n" } : withoutReferenceStamp(doc));
    const before = await backend.read("references/guide");
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionPlanChanged, change);
    assert.equal(backend.writes, 0);
    assert.deepEqual(await backend.read("references/guide"), before);
  }
});

test("Reference evolution: post-preflight CAS and edition races preserve the winner and name every pending target", async () => {
  for (const race of ["content", "edition"]) {
    const { bundle, backend } = await referenceFixture();
    const desired = referenceRecipe("2", "New.\n");
    const plan = await planRecipeEvolution(bundle, desired);
    if (race === "content") backend.beforeCas = () => backend.edit("references/guide", doc => ({ ...doc, body: "Concurrent winner.\n" }));
    else backend.flipEdition = true;
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => {
      assert.ok(error instanceof RecipeEvolutionInterrupted);
      assert.equal(error.reason, race === "content" ? "race" : "edition_changed");
      assert.deepEqual(error.completed, []);
      assert.deepEqual(error.pending, ["references/guide"]);
      return true;
    });
    assert.equal(backend.writes, 0);
    assert.equal((await readDoc(bundle, "references/guide")).body, race === "content" ? "Concurrent winner.\n" : "Original guide.\n");
  }
});

test("Reference evolution: mixed definitions and References retain separate counts and interrupted receipts retry only remaining work", async () => {
  const backend = new DescriptionProbeBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle: Bundle = { root: "mem://mixed-references", backend };
  const ids = ["references/alpha", "references/beta"];
  const old = { ...descriptionRecipe("1", "Old guidance"), references: referenceRecipe("1", undefined, ids).references };
  const desired = { ...descriptionRecipe("2", "New guidance"), references: referenceRecipe("2", "New.\n", ids).references };
  await installRecipe(bundle, old);
  backend.writes = 0;
  const plan = await planRecipeEvolution(bundle, desired);
  assert.equal(plan.ready, true);
  assert.equal(plan.writes, 3);
  assert.equal(plan.counts.updates, 1);
  assert.equal(plan.reference_assets!.counts.updates, 2);
  backend.failId = ids[1]!;
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionInterrupted);
    assert.deepEqual(error.completed.map(row => [row.id, row.asset_kind, row.changed]), [["conventions/widget", undefined, true], [ids[0], "reference", true]]);
    assert.deepEqual(error.pending, [ids[1]]);
    return true;
  });
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionPlanChanged);
  const fresh = await planRecipeEvolution(bundle, desired);
  assert.equal(fresh.ready, true);
  assert.equal(fresh.writes, 1);
  const result = await applyRecipeEvolution(bundle, desired, fresh.plan_token);
  assert.deepEqual(result.counts, { updated: 0, stamped: 0, unchanged: 1 });
  assert.deepEqual(result.reference_assets!.counts, { updated: 1, stamped: 0, unchanged: 1 });
  assert.equal((await planRecipeEvolution(bundle, desired)).writes, 0);
});

test("Reference evolution: no-generated and legacy-clock documents retain edition and writer without manufacturing provenance", async () => {
  for (const edition of ["0.1", "0.2"]) for (const legacyClock of [false, true]) {
    const backend = new DescriptionProbeBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
    const bundle: Bundle = { root: "mem://reference-clocks", backend };
    const old = referenceRecipe();
    delete old.references[0]!.doc.frontmatter.generated;
    if (legacyClock) old.references[0]!.doc.frontmatter.timestamp = NOW;
    await installRecipe(bundle, old, { actor: "process:installer", now: NOW });
    const desired = structuredClone(old);
    desired.version = "2";
    desired.references[0]!.doc.body = "Updated without provenance.\n";
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, true);
    await applyRecipeEvolution(bundle, desired, plan.plan_token, { actor: "process:evolver" });
    const written = await readDoc(bundle, "references/guide");
    assert.equal(written.frontmatter.generated, undefined);
    assert.equal(written.frontmatter[edition === "0.2" ? "superbee_updated_by" : "actor"], "process:evolver");
    assert.equal(Object.hasOwn(written.frontmatter, "timestamp"), edition === "0.1" || legacyClock);
    assert.equal(await readBundleOkfVersion(bundle), edition);
  }
});

test("Reference evolution: a stamp changed after writing fails the postcondition honestly", async () => {
  class PostconditionBackend extends DescriptionProbeBackend {
    disturb = false;
    override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
      const version = await super.write(id, doc, options);
      if (this.disturb && typeof options.expectedVersion === "string") {
        this.disturb = false;
        await this.edit(id, withoutReferenceStamp);
      }
      return version;
    }
  }
  const backend = new PostconditionBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle: Bundle = { root: "mem://reference-postcondition", backend };
  await installRecipe(bundle, referenceRecipe());
  const desired = referenceRecipe("2", "Updated.\n");
  const plan = await planRecipeEvolution(bundle, desired);
  backend.disturb = true;
  await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), (error: unknown) => {
    assert.ok(error instanceof RecipeEvolutionPostcondition);
    assert.equal(error.reason, "changed");
    assert.deepEqual(error.completed.map(row => [row.id, row.asset_kind, row.changed]), [["references/guide", "reference", true]]);
    return true;
  });
  assert.equal(readRecipeStamp(await readDoc(bundle, "references/guide")), null);
  assert.equal((await readDoc(bundle, "references/guide")).body, "Updated.\n");
});

test("Reference evolution: shared storage newline rules settle LF, CRLF and unterminated sources on memory and file backends", async () => {
  for (const file of [false, true]) for (const edition of ["0.1", "0.2"]) for (const ending of ["\n", "\r\n", ""]) {
    const dir = file ? await mkdtemp(path.join(tmpdir(), "reference-line-endings-")) : undefined;
    try {
      let bundle: Bundle;
      if (dir) bundle = await initBundle(dir, { okfVersion: edition });
      else {
        const backend = new MemoryBackend();
        await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
        bundle = { root: "mem://reference-lines", backend };
      }
      const old = referenceRecipe("1", `Original${ending}`);
      await installRecipe(bundle, old);
      assert.equal((await planRecipeEvolution(bundle, old)).writes, 0);
      const desired = referenceRecipe("2", `New${ending}`);
      const plan = await planRecipeEvolution(bundle, desired);
      assert.equal(plan.ready, true);
      await applyRecipeEvolution(bundle, desired, plan.plan_token);
      const written = await readDoc(bundle, "references/guide");
      assert.equal(readRecipeStamp(written)?.definition, definitionDigest(written));
      const settled = await planRecipeEvolution(bundle, desired);
      assert.equal(settled.ready, true);
      assert.equal(settled.writes, 0);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Reference evolution: public core install refuses non-Reference source identity before any write", async () => {
  const backend = new DescriptionProbeBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle: Bundle = { root: "mem://reference-source-identity", backend };
  const recipe = referenceRecipe();
  recipe.references[0]!.doc.frontmatter.type = "Note";
  await assert.rejects(installRecipe(bundle, recipe), RecipeInputError);
  assert.equal(backend.writes, 0);
});

// Recipe declaration order: path-independent lists without laundering a locally edited baseline.
function orderedListRecipe(version: "1" | "2" | "3"): LoadedRecipe {
  const optional = version === "1" ? ["mode", "alpha", "omega", "state"]
    : version === "2" ? ["mode", "alpha", "middle", "omega", "state"]
    : ["mode", "alpha", "before", "middle", "omega", "after", "state"];
  const modes = version === "1" ? ["start", "end"] : version === "2" ? ["start", "middle", "end"] : ["first", "start", "middle", "end", "last"];
  return kindRecipe("ordered-lists", version, [{
    id: "conventions/order", frontmatter: {
      type: "Convention", title: "Order", governs: "Order",
      fields: {
        required: version === "2" ? ["name", "title"] : ["title", "name"], optional,
        values: { mode: modes, state: ["todo", "done", "cancelled"] },
        terminal: { state: version === "2" ? ["cancelled", "done"] : ["done", "cancelled"] },
      },
      sections: version === "2" ? ["Details", "Summary"] : ["Summary", "Details"],
      links: { relates: "Order" }, expects_inbound: { relates: "Order" },
    }, body: "# Order\n",
  }]);
}

async function orderedListBundle(edition: "0.1" | "0.2" = "0.2") {
  const backend = new DescriptionProbeBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  const bundle: Bundle = { root: "mem://ordered-lists", backend };
  await installRecipe(bundle, orderedListRecipe("1"), { now: NOW });
  backend.writes = 0;
  return { bundle, backend };
}

function changeOrderedList(doc: OkfDocument, keys: string[], change: (values: string[]) => string[]): OkfDocument {
  const edited = structuredClone(doc);
  let record = edited.frontmatter as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) record = record[key] as Record<string, unknown>;
  const key = keys.at(-1)!;
  record[key] = change(record[key] as string[]);
  return edited;
}

test("list order: direct, stepped and fresh installs reach identical declarations, stamps and section scaffolds in both editions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  for (const edition of ["0.1", "0.2"] as const) {
    const direct = await orderedListBundle(edition), stepped = await orderedListBundle(edition);
    await evolve(direct.bundle, orderedListRecipe("3"));
    await evolve(stepped.bundle, orderedListRecipe("2"));
    await evolve(stepped.bundle, orderedListRecipe("3"));
    // Independent installation of the final source uses the exact same definition digest.
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
    const fresh: Bundle = { root: "mem://ordered-list-fresh", backend };
    await installRecipe(fresh, orderedListRecipe("3"), { now: NOW });
    const expected = await readDoc(fresh, "conventions/order");
    for (const { bundle } of [direct, stepped]) {
      const installed = await readDoc(bundle, "conventions/order");
      assert.deepEqual(installed, expected);
      assert.equal(definitionDigest(installed), definitionDigest(expected));
      assert.deepEqual(readRecipeStamp(installed), readRecipeStamp(expected));
      const parsed = parseConventionDoc(installed, { okfVersion: edition });
      assert.ok(parsed.ok);
      assert.equal(kindInstanceCandidate(parsed.kind, { title: "Order", name: "One" }).body, "# Summary\n\n# Details\n");
      const settled = await planRecipeEvolution(bundle, orderedListRecipe("3"));
      assert.equal(settled.ready, true);
      assert.equal(settled.writes, 0);
    }
  }
});

test("list order: local reorders and duplicate occurrences block same-version and bumped-version re-stamping", async () => {
  const paths = [["fields", "required"], ["fields", "optional"], ["fields", "values", "mode"], ["fields", "terminal", "state"], ["sections"]];
  for (const keys of paths) for (const duplicate of [false, true]) for (const version of ["1", "2"]) {
    const { bundle, backend } = await orderedListBundle();
    await backend.edit("conventions/order", doc => changeOrderedList(doc, keys, values => duplicate ? [...values, values[0]!] : [...values].reverse()));
    const desired = orderedListRecipe("1");
    desired.version = version;
    const before = await backend.read("conventions/order");
    const plan = await planRecipeEvolution(bundle, desired);
    const pointer = "/frontmatter/" + keys.join("/");
    assert.equal(plan.ready, false, `${pointer} ${version} ${duplicate}`);
    assert.ok(plan.blockers.some(row => row.code === "RECIPE_EVOLUTION_LIST_ORDER_UNPROVEN" && row.field === pointer), JSON.stringify(plan.blockers));
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionBlocked);
    assert.deepEqual(await backend.read("conventions/order"), before);
    assert.equal(backend.writes, 0);
    assert.equal(installedRecipes([(await readDoc(bundle, "conventions/order"))]).rows[0]!.state, "diverged");
  }
});

test("list order: unproved baselines allow occurrence-preserving insertions but refuse reordering", async () => {
  for (const baseline of ["missing", "foreign", "unknown"] as const) {
    const { bundle, backend } = await orderedListBundle();
    await backend.edit("conventions/order", doc => {
      if (baseline === "missing") return withoutStamp(doc);
      return withStamp(doc, { ...readRecipeStamp(doc)!, ...(baseline === "foreign" ? { id: "other-recipe" } : { digest_rules: 999 }) });
    });
    const source = orderedListRecipe("1");
    source.version = "2";
    source.docs[0] = changeOrderedList(source.docs[0]!, ["fields", "optional"], values => [values[0]!, "inserted", ...values.slice(1)]);
    const plan = await planRecipeEvolution(bundle, source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    await applyRecipeEvolution(bundle, source, plan.plan_token);
    assert.deepEqual((await readDoc(bundle, "conventions/order")).frontmatter.fields, source.docs[0]!.frontmatter.fields);
    // A separate unproved baseline cannot use a source reorder as permission to reorder locally.
    await backend.edit("conventions/order", doc => withoutStamp(doc));
    source.docs[0] = changeOrderedList(source.docs[0]!, ["fields", "required"], values => [...values].reverse());
    const before = await backend.read("conventions/order");
    const blocked = await planRecipeEvolution(bundle, source);
    assert.equal(blocked.ready, false);
    await assert.rejects(applyRecipeEvolution(bundle, source, blocked.plan_token), RecipeEvolutionBlocked);
    assert.deepEqual(await backend.read("conventions/order"), before);
  }
});

test("list order: omitted local values and terminal membership or multiplicity changes remain blocked", async () => {
  for (const change of ["local-only", "terminal-add", "terminal-remove", "terminal-duplicate"] as const) {
    const { bundle, backend } = await orderedListBundle();
    const desired = orderedListRecipe("1"); desired.version = "2";
    if (change === "local-only") await backend.edit("conventions/order", doc => changeOrderedList(doc, ["fields", "optional"], values => [...values, "local"]));
    else desired.docs[0] = changeOrderedList(desired.docs[0]!, ["fields", "terminal", "state"], values => change === "terminal-add" ? ["todo", ...values] : change === "terminal-remove" ? values.slice(1) : [...values, values[0]!]);
    const before = await backend.read("conventions/order");
    const plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, false, change);
    assert.ok(plan.blockers.some(row => row.code === (change === "local-only" || change === "terminal-remove" ? "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED" : "RECIPE_EVOLUTION_TERMINAL_CHANGE")), JSON.stringify(plan.blockers));
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionBlocked);
    assert.deepEqual(await backend.read("conventions/order"), before);
    assert.equal(backend.writes, 0);
  }
});

test("list order: changed installed order invalidates a plan before writes and loses no post-preflight CAS race", async () => {
  for (const afterPreflight of [false, true]) {
    const { bundle, backend } = await orderedListBundle();
    const source = orderedListRecipe("3");
    const plan = await planRecipeEvolution(bundle, source);
    const edit = () => backend.edit("conventions/order", doc => changeOrderedList(doc, ["fields", "optional"], values => [...values].reverse()));
    if (afterPreflight) backend.beforeCas = edit;
    else await edit();
    await assert.rejects(applyRecipeEvolution(bundle, source, plan.plan_token), (error: unknown) => afterPreflight
      ? error instanceof RecipeEvolutionInterrupted && error.reason === "race"
      : error instanceof RecipeEvolutionPlanChanged);
    assert.equal(backend.writes, 0);
    assert.deepEqual(((await readDoc(bundle, "conventions/order")).frontmatter.fields as { optional: string[] }).optional, ["state", "omega", "alpha", "mode"]);
  }
});

test("list order: unknown extension arrays retain their existing append-only behavior", async () => {
  const { bundle } = await orderedListBundle();
  const installed = await readDoc(bundle, "conventions/order");
  const backend = bundle.backend as DescriptionProbeBackend;
  await backend.edit(installed.id, doc => ({ ...doc, frontmatter: { ...doc.frontmatter, x_steps: ["old", "tail"] } }));
  const desired = orderedListRecipe("1"); desired.version = "2";
  desired.docs[0]!.frontmatter.x_steps = ["first", "old", "tail"];
  const plan = await planRecipeEvolution(bundle, desired);
  assert.equal(plan.ready, true);
  await applyRecipeEvolution(bundle, desired, plan.plan_token);
  assert.deepEqual((await readDoc(bundle, installed.id)).frontmatter.x_steps, ["old", "tail", "first"]);
});

test("list order: occurrences deliberately declared by the recipe retain their multiplicity", async () => {
  const { bundle } = await orderedListBundle();
  const desired = orderedListRecipe("1"); desired.version = "2";
  desired.docs[0] = changeOrderedList(desired.docs[0]!, ["fields", "optional"], values => [values[0]!, values[1]!, values[1]!, ...values.slice(2)]);
  const plan = await planRecipeEvolution(bundle, desired);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await applyRecipeEvolution(bundle, desired, plan.plan_token);
  const installed = await readDoc(bundle, "conventions/order");
  assert.deepEqual(installed.frontmatter.fields, desired.docs[0]!.frontmatter.fields);
  assert.equal(readRecipeStamp(installed)?.definition, definitionDigest(desired.docs[0]!));
  assert.equal((await planRecipeEvolution(bundle, desired)).writes, 0);
});


test("read-only preparation and direct install agree on every carried artifact in both editions without mutating the source", async () => {
  const calendar = parseRecipeFiles(RECIPE_FILES, "test:prepared-calendar", { okfVersion: "0.2" });
  assert.ok(calendar.ok);
  const recipe = galleryRecipe("1", ["progress_status"]);
  recipe.docs.push(...calendar.recipe.docs);
  recipe.connectors = calendar.recipe.connectors;
  recipe.references = [{ doc: { id: "references/guide", frontmatter: { type: "Reference", title: "Guide" }, body: "# Guide\n" } }];
  recipe.docs[0]!.frontmatter.generated = { by: "process:upstream", at: "2026-10-01T00:00:00.000Z" };
  recipe.docs[0]!.frontmatter.x_unknown = { nested: ["preserved"] };
  recipe.docs[0]!.body = "# Exhibit\n\nWorkflow field: {{superbee:progress_status}}.\n";
  const original = structuredClone(recipe);
  const identities: unknown[] = [];
  for (const okfVersion of ["0.1", "0.2"] as const) {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${okfVersion}'\n---\n`);
    const bundle = { root: `memory://prepare-${okfVersion}`, backend };
    const prepared = prepareRecipeInstall(recipe, { okfVersion, now: NOW });
    assert.deepEqual(prepared, prepareRecipeInstall(recipe, { okfVersion, now: NOW }));
    assert.deepEqual(recipe, original);
    assert.deepEqual(await backend.list(), [], "preparation has no persistent effects");
    assert.equal(prepared.identity.source_digest, recipeSourceDigest(recipe));
    identities.push(prepared.identity);
    const field = okfVersion === "0.1" ? "status" : "superbee_progress_status";
    assert.match(prepared.docs[0]!.body, new RegExp(`Workflow field: ${field}`));
    assert.deepEqual((prepared.docs[0]!.frontmatter.fields as { optional: string[] }).optional, [field]);
    const installed = await installRecipe(bundle, recipe, { now: NOW, actor: "process:prepared-test" });
    assert.equal(installed.counts.created, 5);
    for (const candidate of [...prepared.docs, ...prepared.connectors.map(({ doc }) => doc), ...prepared.references.map(({ doc }) => doc), ...prepared.pages.map(({ registry }) => registry)]) {
      const saved = await readDoc(bundle, candidate.id);
      const authored = { ...saved.frontmatter };
      delete authored[okfVersion === "0.1" ? "actor" : "superbee_updated_by"];
      assert.deepEqual(authored, candidate.frontmatter, `${okfVersion}: ${candidate.id}`);
      assert.equal(saved.body, candidate.body);
      assert.equal(candidate.frontmatter.timestamp, okfVersion === "0.1" ? NOW : undefined);
      if (candidate.frontmatter.type === "View") assert.equal(candidate.frontmatter.x_recipe, undefined);
      else assert.deepEqual(inspectRecipeInstallTarget(saved, candidate, prepared), { exists: true, sameContent: true, stamp: "current", stampIntegrity: "current" });
    }
    assert.deepEqual((await readBlob(bundle, prepared.pages[0]!.entry))!.bytes, new TextEncoder().encode(prepared.pages[0]!.html));
    assert.equal((await installRecipe(bundle, recipe, { now: "2026-10-20T00:00:00.000Z" })).changed, false);
    prepared.docs[0]!.frontmatter.x_unknown = { nested: ["changed candidate"] };
    prepared.connectors[0]!.connector.domains.push("changed.example.org");
    assert.deepEqual(recipe, original, "candidate changes do not mutate parsed source or its nested Connector");
  }
  assert.deepEqual(identities[0], identities[1], "source identity precedes edition materialization");
  assert.throws(() => prepareRecipeInstall(recipe, { okfVersion: "0.2", now: undefined as unknown as string }), RecipeInputError);
});

test("install target inspection separates content, recipe identity and readable stamp integrity without adopting existing data", async () => {
  for (const okfVersion of ["0.1", "0.2"] as const) {
    const recipe = loadRecipe("1", INSTALLED);
    const prepared = prepareRecipeInstall(recipe, { okfVersion, now: NOW });
    const desired = prepared.docs[0]!;
    assert.deepEqual(inspectRecipeInstallTarget(null, desired, prepared), { exists: false, sameContent: false, stamp: "missing", stampIntegrity: "unknown" });
    const stamped = (change: Record<string, unknown>) => ({ ...structuredClone(desired), frontmatter: { ...structuredClone(desired.frontmatter), x_recipe: { ...readRecipeStamp(desired)!, ...change } } });
    const unstamped = structuredClone(desired);
    delete unstamped.frontmatter.x_recipe;
    const managed = structuredClone(desired);
    managed.frontmatter.timestamp = "2026-10-20T00:00:00.000Z";
    managed.frontmatter[okfVersion === "0.1" ? "actor" : "superbee_updated_by"] = "process:another-installer";
    managed.frontmatter.order = 12;
    const rows = [
      ["matching", structuredClone(desired), true, "current", "current"],
      ["managed metadata", managed, true, "current", "current"],
      ["missing", unstamped, true, "missing", "unknown"],
      ["stale", stamped({ version: "0" }), true, "stale", "current"],
      ["foreign", stamped({ id: "another-recipe" }), true, "foreign", "current"],
      ["local content", { ...structuredClone(desired), body: "# Locally authored\n" }, false, "current", "diverged"],
      ["damaged definition stamp", stamped({ definition: "sha256:" + "0".repeat(64) }), true, "current", "diverged"],
      ["unreadable stamp rules", stamped({ digest_rules: 999 }), true, "current", "unknown"],
      ["unknown authored field", { ...structuredClone(desired), frontmatter: { ...desired.frontmatter, x_local: { value: "preserve" } } }, false, "current", "diverged"],
    ] as const;
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${okfVersion}'\n---\n`);
    const bundle = { root: `memory://inspect-${okfVersion}`, backend };
    for (const [name, existing, sameContent, stamp, stampIntegrity] of rows) {
      const original = structuredClone(existing);
      const before = await backend.write(existing.id, existing);
      const inspection = inspectRecipeInstallTarget(existing, desired, prepared);
      assert.deepEqual(inspection, { exists: true, sameContent, stamp, stampIntegrity }, `${okfVersion}: ${name}`);
      const receipt = await installRecipe(bundle, recipe, { now: NOW });
      assert.equal(receipt.changed, false);
      assert.equal(receipt.stamp, stamp, "existing installer identity receipt semantics remain unchanged");
      assert.equal(receipt.docs[0]!.source_differs, sameContent ? undefined : true);
      const preserved = await backend.read(existing.id);
      assert.equal(preserved.version, before, `${name}: install never rewrites or adopts the collision`);
      assert.deepEqual(existing, original, `${name}: inspection never changes the caller's document`);
    }
    assert.throws(() => inspectRecipeInstallTarget({ ...desired, id: "conventions/wrong" }, desired, prepared), RecipeInputError);
  }
});
