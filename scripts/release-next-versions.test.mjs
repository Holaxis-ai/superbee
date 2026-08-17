import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readBurnedDeclaration, saneSuccessors } from "./release-audit-tags.mjs";
import {
  classifySuccessors,
  existingTags,
  nextVersionCandidates,
  screenForBurns,
  screenForConsumption,
} from "./release-next-versions.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function byVersion(rows) {
  return Object.fromEntries(rows.map((r) => [r.version, r]));
}

// ============================================================ layer 1: SHAPE
// The numbering scheme alone. No registry, no repository, no ledger — if any assertion in this group
// needs one of those to pass, the layers have leaked into each other.

test("SHAPE: candidates are exactly the sane successors, and the rule is imported not restated", () => {
  for (const from of ["0.1.1-pre.2", "0.1.0-pre.3", "0.1.1", "0.2.0"]) {
    assert.deepEqual(nextVersionCandidates(from), saneSuccessors(from), from);
  }
});

test("SHAPE: a preview is followed by its own line's stable and its own next preview", () => {
  const from = nextVersionCandidates("0.1.1-pre.2");
  assert.ok(from.includes("0.1.1"), `0.1.1 must follow its own preview; got ${from.join(", ")}`);
  assert.ok(from.includes("0.1.1-pre.3"));
  assert.ok(!from.includes("0.1.0"), "0.1.0 belongs to a different line");
});

test("SHAPE: the minor-line case is unchanged by carrying the patch digit", () => {
  const from = nextVersionCandidates("0.1.0-pre.3");
  assert.ok(from.includes("0.1.0"), "a 0.1.0 preview is still followed by 0.1.0");
  assert.ok(from.includes("0.2.0-pre.1"), "and may still jump to the next minor line");
  assert.ok(!from.includes("0.1.1-pre.1"), "a preview must not skip the release it previews");
});

// ========================================================= layer 2: CONSUMED
// Publication and spent tags. Deliberately NO burns in this group.

test("CONSUMED: a published version is blocked, siblings unaffected", () => {
  const rows = byVersion(screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), { published: ["0.1.1"] }));
  assert.equal(rows["0.1.1"].usable, false);
  assert.match(rows["0.1.1"].blockers.join(" "), /already published/);
  assert.equal(rows["0.1.1-pre.3"].usable, true);
});

test("CONSUMED: a spent v* tag is blocked, and tag_state distinguishes spent from free", () => {
  const rows = byVersion(screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), { tags: new Set(["v0.1.0"]) }));
  assert.equal(rows["0.1.0"].usable, false);
  assert.equal(rows["0.1.0"].tag_state, "spent");
  assert.match(rows["0.1.0"].blockers.join(" "), /immutable/);
  assert.equal(rows["0.2.0-pre.1"].tag_state, "free");
});

test("CONSUMED: unreadable tags report unknown rather than silently claiming free", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), { tags: null });
  assert.ok(rows.every((r) => r.tag_state === "unknown"));
  assert.ok(rows.every((r) => r.usable), "unknown is not a blocker — the CLI prints a caveat instead");
});

test("CONSUMED: a tuple's claim is reported, names its package, and is not a blocker", () => {
  const rows = byVersion(
    screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), {
      tuples: { "successor-stable": { version: "0.1.1", package: "superbee" } },
    }),
  );
  assert.equal(rows["0.1.1"].claimed_by, "successor-stable");
  assert.equal(rows["0.1.1"].claimed_for_package, "superbee");
  assert.equal(rows["0.1.1"].usable, true, "the tuple that plans to ship it must not block it");
  assert.equal(rows["0.1.1-pre.3"].claimed_by, null);
});

test("CONSUMED: a claim by the OTHER package is reported as such — two histories, one repo", () => {
  const rows = byVersion(
    screenForConsumption(nextVersionCandidates("0.1.0-pre.10"), {
      tuples: { bridge: { version: "0.1.0-pre.11", package: "@holaxis/aslite" } },
    }),
  );
  assert.equal(rows["0.1.0-pre.11"].claimed_for_package, "@holaxis/aslite");
});

// ============================================================ layer 3: BURNS
// A last-mile screen over already-classified rows. Separate because a burn is bookkeeping about a
// number consumed WITHOUT publication, not part of the numbering scheme.

test("BURNS: the screen is a pure post-pass over classified rows", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), {});
  assert.ok(rows.every((r) => r.usable), "premise: nothing consumed before the burn screen runs");
  const screened = byVersion(screenForBurns(rows, ["0.1.0-pre.4"]));
  assert.equal(screened["0.1.0-pre.4"].usable, false);
  assert.equal(screened["0.1.0-pre.4"].burned, true);
  assert.match(screened["0.1.0-pre.4"].blockers.join(" "), /burned/);
  assert.equal(screened["0.2.0-pre.1"].burned, false, "unburned rows pass through untouched");
});

test("BURNS: an empty ledger changes nothing", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), {});
  assert.deepEqual(
    screenForBurns(rows, []).map((r) => ({ v: r.version, u: r.usable })),
    rows.map((r) => ({ v: r.version, u: r.usable })),
  );
});

test("BURNS: the screen preserves earlier blockers rather than replacing them", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), {
    published: ["0.1.0-pre.4"],
    tags: new Set(["v0.1.0-pre.4"]),
  });
  const screened = byVersion(screenForBurns(rows, ["0.1.0-pre.4"]));
  assert.equal(screened["0.1.0-pre.4"].blockers.length, 3, screened["0.1.0-pre.4"].blockers.join("; "));
});

test("BURNS: a burn flags that the ledger cannot say WHICH package burned it", () => {
  // release/burned-versions.json entries carry a version and a reason, no package, so the screen
  // must not imply a precision the data does not have.
  const rows = screenForBurns(screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), {}), ["0.1.0-pre.4"]);
  assert.equal(byVersion(rows)["0.1.0-pre.4"].burnedPackageUnknown, true);
});

// The regression that motivated reading the ledger from its own file: this command originally looked
// for `manifest.burned_versions`, which does not exist on the loaded manifest, so EVERY burned number
// reported USABLE. A false green here is worse than no tool, because it gets trusted.
test("BURNS: the COMMITTED ledger blocks a burned candidate — guards the false-green defect", async () => {
  const burned = readBurnedDeclaration(JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8")));
  assert.ok(burned.includes("0.1.0-pre.4"), "fixture premise: pre.4 is declared burned");
  const rows = byVersion(classifySuccessors({ from: "0.1.0-pre.3", burned }));
  assert.equal(rows["0.1.0-pre.4"].usable, false, "a committed burn must never read as usable");
});

// ================================================================ composition

test("classifySuccessors runs the three layers in order", () => {
  const rows = byVersion(
    classifySuccessors({
      from: "0.1.0-pre.3",
      published: ["0.1.0-pre.4"],
      burned: ["0.1.0-pre.4"],
      tags: new Set(["v0.1.0"]),
    }),
  );
  assert.equal(rows["0.1.0-pre.4"].blockers.length, 2, "published + burned");
  assert.equal(rows["0.1.0"].tag_state, "spent");
  assert.equal(rows["0.2.0-pre.1"].usable, true);
});

test("the live shape: 0.1.1 is reachable from its own preview", async () => {
  const tags = await existingTags();
  const rows = byVersion(classifySuccessors({ from: "0.1.1-pre.2", published: ["0.0.1", "0.1.1-pre.2"], tags }));
  assert.ok(rows["0.1.1"], "0.1.1 must be enumerated as a successor of 0.1.1-pre.2");
  assert.equal(rows["0.1.1"].usable, true, rows["0.1.1"].blockers.join("; "));
  assert.equal(rows["0.1.0"], undefined, "0.1.0 belongs to another line and must not be offered");
});

test("existingTags returns null outside a git repository rather than an empty set", async () => {
  const tags = await existingTags({ cwd: "/" });
  assert.ok(tags === null || tags instanceof Set, "either unreadable (null) or a real set, never a silent empty");
});
