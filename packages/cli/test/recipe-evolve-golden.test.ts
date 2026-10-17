/**
 * Byte-identity of `recipe evolve` plans, plan tokens included, for recipes that add no
 * `fields.types` entry and no `fields.values` entry to an installed field. The golden transcript is
 * captured on these scenarios under a fixed clock and a fixed recipe source; a diff here is a
 * contract change (AXI-CONTRACT, "Recipe evolve may add field types and enums" and "Recipe install
 * stamps", which added `writes`, each definition's `stamp` and `counts.stamp_writes`, and moved
 * every token), not a fixture refresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle, writeDoc } from "@superbee/core";
import { installRecipe, planRecipeEvolution } from "@superbee/core/recipe-lifecycle";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipe-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, "fixtures", "recipe-evolve-golden", "plans.txt");

const manifest = (version: string): string =>
  `---\ntype: Recipe\nid: widget-workflow\ntitle: Widget workflow\nversion: "${version}"\nsummary: Widget definitions.\n---\n`;

const convention = (fields: string, extra = ""): string =>
  `---\ntype: Convention\ntitle: Widget\ngoverns: Widget\npath: widgets/\nfields:\n${fields}${extra}---\n# Widget\n`;

const INSTALLED = convention(
  "  required: [title]\n  optional: [setting, size]\n  values:\n    setting: [indoor, outdoor]\n",
  "x_field_types:\n  size: string\n",
);

const SCENARIOS: Array<{ name: string; desired: string }> = [
  {
    name: "ready: a new optional field",
    desired: convention(
      "  required: [title]\n  optional: [setting, size, colour]\n  values:\n    setting: [indoor, outdoor]\n",
      "x_field_types:\n  size: string\n",
    ),
  },
  {
    name: "blocked: a newly required field with a non-conforming instance",
    desired: convention(
      "  required: [title, priority]\n  optional: [setting, size]\n  values:\n    setting: [indoor, outdoor]\n",
      "x_field_types:\n  size: string\n",
    ),
  },
  {
    name: "blocked: a new field's enum an instance already violates",
    desired: convention(
      "  required: [title]\n  optional: [setting, size, finish]\n  values:\n    setting: [indoor, outdoor]\n    finish: [matte, gloss]\n",
      "x_field_types:\n  size: string\n",
    ),
  },
  {
    name: "blocked: a narrowed enum, a retyped site type and a removed field",
    desired: convention(
      "  required: [title]\n  optional: [setting]\n  values:\n    setting: [indoor]\n",
      "x_field_types:\n  size: integer\n",
    ),
  },
];

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

test("golden: recipe evolve plans are byte-identical for recipes that add no field types or enums", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T12:00:00.000Z") });
  let transcript = "";
  for (const scenario of SCENARIOS) {
    const dir = await mkdtemp(path.join(tmpdir(), "superbee-evolve-golden-"));
    try {
      const bundle = { root: dir };
      await initBundle(dir);
      await installRecipe(bundle, loadRecipe("1", INSTALLED), { now: "2026-10-14T12:00:00.000Z" });
      await writeDoc(bundle, {
        id: "widgets/one",
        frontmatter: { type: "Widget", title: "One", setting: "outdoor", size: "large", finish: "satin" },
        body: "In use.",
      });
      const plan = await planRecipeEvolution(bundle, loadRecipe("2", scenario.desired));
      transcript += `## ${scenario.name}\n${JSON.stringify(plan, null, 2)}\n`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.equal(transcript, await readFile(GOLDEN, "utf8"));
});
