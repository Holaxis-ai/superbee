/**
 * The portable `engineering-review` recipe: it parses strictly, installs its four review kinds plus
 * the shared View convention with no instances, resolves by NAME from the shipped npm projection as
 * well as by path, stays idempotent, and composes with the lighter `review-workflow` recipe rather
 * than colliding with it.
 *
 * The composition test is the executable evidence for one deliberate deviation from the spec's file
 * names: `review-workflow` already ships `conventions/review-request.md` governing `Review Request`,
 * and recipe application is expect-absent CAS, so a second recipe shipping that same doc id would
 * silently install nothing and leave the other recipe's schema in place. The two colliding kinds are
 * therefore `Engineering Review Request` and `Engineering Review`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { freshnessHorizonMs, initBundle, loadKinds, query, queryEdges, readBlob, readDoc } from "@superbee/core";

import { kinds } from "../src/commands/kinds.js";
import { newCommand } from "../src/commands/new.js";
import { recipe } from "../src/commands/recipe.js";
import { list } from "../src/commands/list.js";
import { CliError } from "../src/errors.js";
import { filesRecipeSource, shippedRecipeNames, shippedRecipeSource } from "../src/recipe-source.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RECIPE_DIR = path.join(REPO_ROOT, "examples/recipes/engineering-review");
const REVIEW_WORKFLOW_RECIPE = path.join(REPO_ROOT, "examples/recipes/review-workflow");
const CANONICAL_VIEW_CONVENTION = path.join(REPO_ROOT, "examples/views/conventions/view.md");
const CANONICAL_VIEW_REFERENCE = path.join(REPO_ROOT, "examples/views/references/view-authoring-v0.md");
/** The npm projection is where a name-addressed install reads from; `check:skill` pins it byte-identical. */
const SHIPPED_PACKAGE_ROOT = path.join(REPO_ROOT, "packages/cli");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "superbee-engineering-review-test-"));
}

async function runJson(
  command: (
    argv: string[],
    deps: { stdout: (value: string) => void; readStdin?: () => Promise<string | undefined> },
  ) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let output = "";
  await command([...argv, "--json"], {
    stdout: (value) => (output += value),
    readStdin: async () => undefined,
  });
  return JSON.parse(output) as Record<string, unknown>;
}

/** A bundle with the recipe applied, plus a cleanup. */
async function bundleWithRecipe(ref: string = RECIPE_DIR): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  await initBundle(dir);
  await runJson(recipe, ["add", ref, "--dir", dir]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("engineering-review parses strictly as definitions-only and declares four review kinds plus View", async () => {
  const loaded = await filesRecipeSource().resolve(RECIPE_DIR);
  assert.ok(loaded);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error.message);
  if (!loaded.ok) return;

  assert.equal(loaded.recipe.id, "engineering-review");
  assert.equal(loaded.recipe.contentPolicy, "definitions-only");
  assert.deepEqual(loaded.recipe.warnings, [], "definitions-only parsing rejects any convention warning");
  assert.deepEqual(loaded.recipe.governs, [
    "Engineering Review Request",
    "Engineering Review",
    "Repair Evidence",
    "Review Finding",
    "View",
  ]);
  assert.equal(loaded.recipe.pages.length, 1);
  assert.equal(loaded.recipe.pages[0]!.registry.id, "views-registry/engineering-review-ledger");
  assert.equal(loaded.recipe.pages[0]!.entry, "views/engineering-review/ledger.html");
  assert.equal(loaded.recipe.pages[0]!.registry.frontmatter.access, "bundle-read");
  assert.deepEqual(
    loaded.recipe.references.map(({ doc }) => doc.id).sort(),
    ["references/engineering-review-playbook", "references/view-authoring-v0"],
  );
});

test("the View-bearing recipe carries the canonical View convention and authoring reference byte-for-byte", async () => {
  assert.deepEqual(
    await readFile(path.join(RECIPE_DIR, "conventions/view.md")),
    await readFile(CANONICAL_VIEW_CONVENTION),
  );
  assert.deepEqual(
    await readFile(path.join(RECIPE_DIR, "references/view-authoring-v0.md")),
    await readFile(CANONICAL_VIEW_REFERENCE),
  );
});

test("recipe add installs the kinds, the playbook, and the ledger View — and no instances", async () => {
  const { dir, cleanup } = await bundleWithRecipe();
  try {
    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.warnings, []);
    assert.deepEqual(
      [...registry.kinds.keys()].sort(),
      ["Engineering Review", "Engineering Review Request", "Repair Evidence", "Review Finding", "View"],
    );

    const request = registry.kinds.get("Engineering Review Request")!;
    // Declared logically as `progress_status`; a v0.1 bundle stores it as `status`.
    assert.deepEqual(request.fields.required, [
      "title",
      "status",
      "reviewer",
      "requested_by",
      "target",
      "target_version",
      "review_question",
      "risk_tier",
    ]);
    assert.deepEqual(request.fields.terminal, { status: ["approved", "canceled"] });
    assert.deepEqual(request.fields.values.risk_tier, ["trivial", "routine", "high_risk"]);
    assert.deepEqual(request.sections, ["Scope", "Acceptance criteria", "Evidence to inspect", "Non-goals"]);
    assert.equal(freshnessHorizonMs(request), 30 * 86_400_000);

    const review = registry.kinds.get("Engineering Review")!;
    assert.ok(review.fields.required.includes("target_version"), "a verdict is bound to an exact version");
    assert.deepEqual(review.fields.terminal, { verdict: ["approved", "superseded"] });
    assert.deepEqual(review.links, { answers: "Engineering Review Request", supersedes: "Engineering Review" });
    assert.deepEqual(review.expectsInbound, { "raised by": "Review Finding" });

    const finding = registry.kinds.get("Review Finding")!;
    assert.ok(finding.fields.required.includes("defect_class"));
    assert.ok(finding.fields.required.includes("found_in_version"));
    assert.deepEqual(finding.fields.values.disposition, [
      "unresolved",
      "repaired",
      "accepted_risk",
      "superseded",
      "rejected_invalid",
    ]);
    assert.deepEqual(finding.fields.terminal, {
      disposition: ["repaired", "accepted_risk", "superseded", "rejected_invalid"],
    });
    assert.deepEqual(finding.expectsInbound, { repairs: "Repair Evidence" });

    const evidence = registry.kinds.get("Repair Evidence")!;
    assert.deepEqual(evidence.fields.values.parent_red, ["proven", "not_applicable", "missing"]);
    assert.deepEqual(evidence.fields.values.head_green, ["proven", "failing", "missing"]);
    assert.deepEqual(evidence.fields.values.probe_source, ["real_artifact", "hand_authored"]);
    assert.deepEqual(evidence.links, { repairs: "Review Finding" });

    for (const type of ["Engineering Review Request", "Engineering Review", "Review Finding", "Repair Evidence"]) {
      assert.equal((await query({ root: dir }, { type })).length, 0, `${type} must install zero instances`);
    }

    const views = await query({ root: dir }, { type: "View" });
    assert.equal(views.length, 1);
    assert.equal(views[0]!.frontmatter.title, "Repair ledger");
    assert.equal(views[0]!.frontmatter.access, "bundle-read");
    const html = await readBlob({ root: dir }, "views/engineering-review/ledger.html");
    assert.ok(html);
    const ledger = Buffer.from(html.bytes).toString("utf8");
    assert.match(ledger, /Repair ledger/);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(ledger), "the View must be self-contained with no external hosts");

    const playbook = await readDoc({ root: dir }, "references/engineering-review-playbook");
    assert.equal(playbook.frontmatter.type, "Reference");
    assert.match(playbook.body, /parent-red/i);
  } finally {
    await cleanup();
  }
});

test("the kinds command teaches each declared field and enum value", async () => {
  const { dir, cleanup } = await bundleWithRecipe();
  try {
    const projected = await runJson(kinds, ["--dir", dir]);
    const rows = projected.kinds as Array<Record<string, unknown>>;
    const evidence = rows.find((row) => row.governs === "Repair Evidence")!;
    const descriptions = evidence.descriptions as Record<string, string>;
    for (const field of ["repair_commit", "repaired_version", "probe", "probe_source", "parent_red", "head_green"]) {
      assert.ok(descriptions[field], `Repair Evidence must describe ${field}`);
    }
    const valueDescriptions = evidence.value_descriptions as Record<string, Record<string, string>>;
    assert.ok(valueDescriptions.parent_red!.missing);
    assert.ok(valueDescriptions.probe_source!.hand_authored);

    const finding = rows.find((row) => row.governs === "Review Finding")!;
    assert.deepEqual(finding.sections, ["Defect class", "Failure scenario", "Repair expectation"]);
    assert.equal(finding.horizon, "30d");
  } finally {
    await cleanup();
  }
});

test("the installed kinds accept a full round and reject undeclared values", async () => {
  const { dir, cleanup } = await bundleWithRecipe();
  try {
    await runJson(newCommand, [
      "Engineering Review Request", "cache",
      "--title", "Cache invalidation",
      "--progress_status", "in_review",
      "--reviewer", "reviewer",
      "--requested_by", "requester",
      "--target", "feat/cache",
      "--target_version", "aaaa111",
      "--review_question", "Does the cache stay correct under concurrent invalidation?",
      "--risk_tier", "high_risk",
      "--dir", dir,
    ]);
    await runJson(newCommand, [
      "Engineering Review", "cache-r1",
      "--title", "Cache round 1",
      "--target", "feat/cache",
      "--target_version", "aaaa111",
      "--verdict", "changes_requested",
      "--reviewer", "reviewer",
      "--round", "1",
      "--link", "answers=engineering-review-requests/cache",
      "--dir", dir,
    ]);
    await runJson(newCommand, [
      "Review Finding", "stale-read",
      "--title", "Stale entry served after eviction",
      "--severity", "high",
      "--disposition", "unresolved",
      "--defect_class", "read path does not re-check the generation counter",
      "--found_in_version", "aaaa111",
      "--link", "raised by=engineering-reviews/cache-r1",
      "--dir", dir,
    ]);
    await runJson(newCommand, [
      "Repair Evidence", "stale-read",
      "--title", "Generation re-check",
      "--repair_commit", "bbbb222",
      "--repaired_version", "bbbb222",
      "--probe", "cache/test/concurrent-invalidation.test.ts",
      "--probe_source", "real_artifact",
      "--parent_red", "proven",
      "--head_green", "proven",
      "--link", "repairs=review-findings/stale-read",
      "--dir", dir,
    ]);

    assert.deepEqual(
      (await queryEdges({ root: dir }, { from: "repair-evidence/stale-read" })).map(({ text, to }) => ({ text, to })),
      [{ text: "repairs", to: "review-findings/stale-read" }],
    );
    assert.deepEqual(
      (await queryEdges({ root: dir }, { to: "engineering-reviews/cache-r1" })).map(({ text, from }) => ({ text, from })),
      [{ text: "raised by", from: "review-findings/stale-read" }],
    );

    // An unresolved finding is open; dispositioning it terminally drops it from `list --open`.
    const open = await runJson(list, ["--type", "Review Finding", "--open", "--dir", dir]);
    assert.equal(open.count, 1);
    await runJson(newCommand, [
      "Review Finding", "closed",
      "--title", "Closed by acceptance",
      "--severity", "low",
      "--disposition", "accepted_risk",
      "--defect_class", "documentation drift",
      "--found_in_version", "aaaa111",
      "--owner", "owner",
      "--rationale", "Tracked separately",
      "--dir", dir,
    ]);
    const stillOpen = await runJson(list, ["--type", "Review Finding", "--open", "--dir", dir]);
    assert.equal(stillOpen.count, 1, "a terminal disposition is not open work");

    for (const [kind, id, flag, value] of [
      ["Review Finding", "bad-disposition", "--disposition", "fixed"],
      ["Repair Evidence", "bad-parent-red", "--parent_red", "yes"],
      ["Engineering Review", "bad-verdict", "--verdict", "lgtm"],
    ] as const) {
      await assert.rejects(
        () => newCommand([kind, id, "--title", "x", flag, value, "--dir", dir], { stdout: () => {} }),
        (error: unknown) => error instanceof CliError && error.code === "USAGE",
      );
    }
  } finally {
    await cleanup();
  }
});

test("engineering-review resolves by NAME from the shipped projection and stays idempotent", async () => {
  const names = await shippedRecipeNames(SHIPPED_PACKAGE_ROOT);
  assert.ok(names.includes("engineering-review"), `shipped names were ${names.join(", ")}`);

  const loaded = await shippedRecipeSource(SHIPPED_PACKAGE_ROOT).resolve("engineering-review");
  assert.ok(loaded);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error.message);
  if (!loaded.ok) return;
  assert.equal(loaded.recipe.id, "engineering-review");

  const { dir, cleanup } = await bundleWithRecipe(path.join(SHIPPED_PACKAGE_ROOT, "references/recipes/engineering-review"));
  try {
    const again = await runJson(recipe, [
      "add",
      path.join(SHIPPED_PACKAGE_ROOT, "references/recipes/engineering-review"),
      "--dir",
      dir,
    ]);
    assert.equal(again.changed, false);
    assert.equal(again.recipe, "already applied");
    assert.deepEqual(again.counts, { created: 0, existing: 8, legacy_present: 0, migration_required: 0 });
  } finally {
    await cleanup();
  }
});

test("engineering-review composes with review-workflow — neither recipe adopts the other's schema", async () => {
  const { dir, cleanup } = await bundleWithRecipe();
  try {
    const composed = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(composed.changed, true);
    assert.deepEqual(composed.warnings, undefined, "no duplicate-governs warning: the kinds are distinct");

    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.warnings, []);
    assert.deepEqual(
      [...registry.kinds.keys()].sort(),
      [
        "Engineering Review",
        "Engineering Review Request",
        "Repair Evidence",
        "Review Finding",
        "Review Request",
        "View",
      ],
    );
    // The lightweight kind keeps its own smaller schema; the exact-target one keeps its version fields.
    assert.ok(!registry.kinds.get("Review Request")!.fields.required.includes("target_version"));
    assert.ok(registry.kinds.get("Engineering Review Request")!.fields.required.includes("target_version"));
    assert.equal((await query({ root: dir }, { type: "View" })).length, 2);

    const reapplied = await runJson(recipe, ["add", RECIPE_DIR, "--dir", dir]);
    assert.equal(reapplied.changed, false, "composition leaves engineering-review idempotent");
  } finally {
    await cleanup();
  }
});

test("recipe add leaves a pre-existing unrelated convention untouched", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    const hand = "---\ntype: Convention\ntitle: Widget\ngovers_typo: ignored\ngoverns: Widget\n---\n# Widget\n";
    await writeFile(path.join(dir, "conventions", "widget.md"), hand, "utf8");

    await runJson(recipe, ["add", RECIPE_DIR, "--dir", dir]);
    assert.equal(await readFile(path.join(dir, "conventions", "widget.md"), "utf8"), hand);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an instance-bearing variant of the recipe is rejected before any write", async () => {
  const dir = await tempDir();
  const bundle = await tempDir();
  try {
    const variant = path.join(dir, "engineering-review");
    await mkdir(path.join(variant, "conventions"), { recursive: true });
    await writeFile(
      path.join(variant, "recipe.md"),
      await readFile(path.join(RECIPE_DIR, "recipe.md"), "utf8")
        .then((text) => text.replace(/^references:\n(?:  - .*\n)+/m, "").replace(/^pages:\n(?:  .*\n)+/m, "")),
      "utf8",
    );
    await writeFile(
      path.join(variant, "conventions", "review-finding.md"),
      await readFile(path.join(RECIPE_DIR, "conventions/review-finding.md"), "utf8"),
      "utf8",
    );
    await mkdir(path.join(variant, "review-findings"), { recursive: true });
    await writeFile(
      path.join(variant, "review-findings", "seeded.md"),
      "---\ntype: Review Finding\ntitle: Seeded\nseverity: high\ndisposition: unresolved\n" +
        "defect_class: seeded\nfound_in_version: aaaa111\n---\n# Defect class\n",
      "utf8",
    );

    await initBundle(bundle);
    await assert.rejects(
      () => recipe(["add", variant, "--dir", bundle, "--json"], { stdout: () => {} }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "USAGE" &&
        /definitions-only/.test(error.message) &&
        /review-findings\/seeded\.md/.test(error.message),
    );
    assert.equal((await query({ root: bundle }, { type: "Review Finding" })).length, 0);
    assert.equal((await query({ root: bundle }, { type: "Convention" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(bundle, { recursive: true, force: true });
  }
});
