/**
 * `@superbee/core/recipe-lifecycle` on MemoryBackend: install, plan and apply through core alone,
 * plan-token byte identity with the CLI's golden transcript, and one named path per typed error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBlob, readDoc, writeBlob, writeDoc } from "../src/bundle-ops.js";
import { InvalidInputError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipes.js";
import type { Bundle, ConceptId, OkfDocument, ReservedFilename, ReservedReadResult, Version, WriteOptions } from "../src/types.js";
import {
  applyRecipeEvolution,
  installRecipe,
  installedConventionDocs,
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
  assert.deepEqual(applied.counts, { updated: 1, unchanged: 0 });
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
