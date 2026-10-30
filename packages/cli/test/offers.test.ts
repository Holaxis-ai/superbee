/**
 * offers.ts — the pure unused-capability derivation (plan: proactive-onboarding-prompts).
 * ROW TABLE: suggestion-derivation findings land here as rows, not one-off tests beside fixes.
 * Each row states the bundle facts (byType + conventions/ ids) and the exact expected offers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveOffers, OFFERS_HELP, type OfferRow } from "../src/offers.js";
import { parseRecipeFiles } from "@superbee/core/recipes";
import { testFragment, testInvocation } from "./support/command-prefix.js";

const INVOKE = testInvocation("npx --no-install superbee");

const CONTEXT_NOTES: OfferRow = {
  recipe: "context-notes",
  offer: "give agents persistent memory between sessions",
  command: `${INVOKE} recipe add context-notes`,
};
const WORK_TRACKING: OfferRow = {
  recipe: "work-tracking",
  offer: "set up a shared task list for this project",
  command: `${INVOKE} recipe add work-tracking`,
};
const ROADMAP: OfferRow = {
  recipe: "roadmap",
  offer: "map out where the project is going",
  command: `${INVOKE} recipe add roadmap`,
};

const SITE: OfferRow = {
  recipe: "site",
  offer: "describe a private content site using a shared presentation",
  command: `${INVOKE} recipe add site`,
};

const ROWS: Array<{
  name: string;
  byType: Record<string, number>;
  conventionIds: string[];
  expected: OfferRow[];
}> = [
  {
    // AC1: the applied context-notes Convention excludes itself; the other three fill the cap.
    name: "fresh-default (context-notes applied, no instances)",
    byType: { Convention: 1 },
    conventionIds: ["conventions/context-note"],
    expected: [WORK_TRACKING, ROADMAP, SITE],
  },
  {
    // AC3 + cap + ordering: four capabilities are unused; only the first three fill the cap.
    name: "recipe-none-empty (0 docs)",
    byType: {},
    conventionIds: [],
    expected: [CONTEXT_NOTES, WORK_TRACKING, ROADMAP],
  },
  {
    name: "applied-with-instances (work-tracking + Task docs): only unapplied recipes derive",
    byType: { Convention: 2, "Context Note": 3, Task: 4 },
    conventionIds: ["conventions/context-note", "conventions/task"],
    expected: [ROADMAP, SITE],
  },
  {
    name: "applied-without-instances: an applied recipe never re-offers",
    byType: { Convention: 2 },
    conventionIds: ["conventions/context-note", "conventions/task"],
    expected: [ROADMAP, SITE],
  },
  {
    // AC3: hand-authored governed instances suppress the recipe even when it is not applied.
    name: "instances-without-recipe (Task docs, no conventions)",
    byType: { Task: 2 },
    conventionIds: [],
    expected: [CONTEXT_NOTES, ROADMAP, SITE],
  },
  {
    name: "one governed type of several suffices (Roadmap Item docs suppress roadmap)",
    byType: { "Roadmap Item": 1 },
    conventionIds: [],
    expected: [CONTEXT_NOTES, WORK_TRACKING, SITE],
  },
  {
    name: "partial application still counts as unapplied (roadmap convention without roadmap-item)",
    byType: { Convention: 1 },
    conventionIds: ["conventions/roadmap"],
    expected: [CONTEXT_NOTES, WORK_TRACKING, ROADMAP],
  },
  {
    name: "older mature bundle still offers missing Site authoring scaffolding",
    byType: { Convention: 4, Task: 1 },
    conventionIds: ["conventions/context-note", "conventions/task", "conventions/roadmap", "conventions/roadmap-item"],
    expected: [SITE],
  },
  {
    name: "a Site instance suppresses missing Site scaffolding without an installed convention",
    byType: { Convention: 4, Site: 1 },
    conventionIds: ["conventions/context-note", "conventions/task", "conventions/roadmap", "conventions/roadmap-item"],
    expected: [],
  },
  {
    name: "all capabilities in use: no offers at all",
    byType: { Convention: 5, Task: 1 },
    conventionIds: [
      "conventions/context-note",
      "conventions/task",
      "conventions/roadmap",
      "conventions/roadmap-item",
      "conventions/site",
    ],
    expected: [],
  },
];

for (const rowCase of ROWS) {
  test(`deriveOffers row: ${rowCase.name}`, () => {
    const offers = deriveOffers(rowCase.byType, rowCase.conventionIds, INVOKE);
    assert.deepEqual(offers, rowCase.expected);
    assert.ok(offers.length <= 3, "offers stay capped at 3");
  });
}

test("deriveOffers appends the caller's --dir suffix verbatim to every command", () => {
  const offers = deriveOffers({}, [], INVOKE, testFragment(" --dir '/tmp/my bundle'"));
  assert.equal(offers.length, 3);
  for (const row of offers) {
    assert.equal(row.command, `${INVOKE} recipe add ${row.recipe} --dir '/tmp/my bundle'`);
  }
});

test("deriveOffers is deterministic (same facts, same rows)", () => {
  const facts = { byType: { Convention: 1 }, ids: ["conventions/context-note"] };
  assert.deepEqual(
    deriveOffers(facts.byType, facts.ids, INVOKE),
    deriveOffers(facts.byType, facts.ids, INVOKE),
  );
});

test("OFFERS_HELP carries the intent guard verbatim", () => {
  assert.equal(
    OFFERS_HELP,
    "capabilities this bundle is not using — when the user is orienting rather than mid-request, " +
      "offer 2-3 as one-line options and ask which first; apply only after they choose",
  );
});

test("a manifest without `offer` falls back to the recipe title; an explicit `offer` wins", () => {
  const convention = [
    "---",
    "type: Convention",
    "governs: Widget",
    "---",
    "# Widget",
  ].join("\n");
  const withoutOffer = parseRecipeFiles(
    [
      {
        path: "recipe.md",
        bytes: "---\ntype: Recipe\nid: widgets\ntitle: Widgets\nversion: \"1\"\nsummary: widget tracking\n---\n",
      },
      { path: "conventions/widget.md", bytes: convention },
    ],
    "builtin:widgets",
  );
  assert.ok(withoutOffer.ok);
  assert.equal(withoutOffer.recipe.offer, "Widgets");

  const withOffer = parseRecipeFiles(
    [
      {
        path: "recipe.md",
        bytes:
          "---\ntype: Recipe\nid: widgets\ntitle: Widgets\nversion: \"1\"\nsummary: widget tracking\noffer: track widgets end to end\n---\n",
      },
      { path: "conventions/widget.md", bytes: convention },
    ],
    "builtin:widgets",
  );
  assert.ok(withOffer.ok);
  assert.equal(withOffer.recipe.offer, "track widgets end to end");
});
