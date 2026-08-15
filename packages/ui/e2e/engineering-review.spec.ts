/**
 * The Engineering Review recipe's repair-ledger View, driven through the REAL built `superbee ui`
 * over a bundle the recipe was installed into BY NAME. Covers the three states the ledger exists to
 * distinguish: empty, open (unresolved findings and incomplete proofs), and resolved.
 */
import { test, expect } from "@playwright/test";
import { bootUiOverEngineeringReviewBundle, openRegisteredView, type SeedDoc } from "./harness.js";

const LEDGER = "views-registry/engineering-review-ledger";

const REVIEW: SeedDoc = {
  id: "engineering-reviews/cache-r1",
  frontmatter: {
    type: "Engineering Review",
    title: "Cache round 1",
    target: "feat/cache",
    target_version: "aaaa111",
    verdict: "changes_requested",
    reviewer: "reviewer",
    round: 1,
  },
  body: "",
};

function finding(id: string, overrides: Record<string, unknown>): SeedDoc {
  return {
    id: `review-findings/${id}`,
    frontmatter: {
      type: "Review Finding",
      title: `Finding ${id}`,
      severity: "high",
      disposition: "unresolved",
      defect_class: `class of ${id}`,
      found_in_version: "aaaa111",
      ...overrides,
    },
    body: `[raised by](../engineering-reviews/cache-r1.md)`,
  };
}

function evidence(id: string, overrides: Record<string, unknown>): SeedDoc {
  return {
    id: `repair-evidence/${id}`,
    frontmatter: {
      type: "Repair Evidence",
      title: `Evidence ${id}`,
      repair_commit: "bbbb222",
      repaired_version: "bbbb222",
      probe: "test/probe.test.ts",
      probe_source: "real_artifact",
      parent_red: "proven",
      head_green: "proven",
      ...overrides,
    },
    body: `[repairs](../review-findings/${id}.md)`,
  };
}

test("the repair ledger reports its empty state over a freshly installed recipe", async ({ page }) => {
  const ui = await bootUiOverEngineeringReviewBundle();
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, LEDGER);
    const frame = page.frameLocator("iframe.page-frame-iframe");

    await expect(frame.getByRole("heading", { name: "Repair ledger" })).toBeVisible();
    await expect(frame.locator("#empty")).toContainText("No Review Findings");
    await expect(frame.locator("#summary")).toHaveText("No Review Findings yet.");
    await expect(frame.locator("body")).toHaveAttribute("data-state", "empty");
    await expect(frame.locator(".finding")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("the repair ledger surfaces unresolved findings and every kind of incomplete proof", async ({ page }) => {
  const ui = await bootUiOverEngineeringReviewBundle([
    REVIEW,
    finding("stale-read", {}),
    finding("no-evidence", { disposition: "repaired" }),
    finding("no-rationale", { disposition: "accepted_risk" }),
    finding("half-proven", { disposition: "repaired" }),
    evidence("half-proven", { parent_red: "missing" }),
    finding("hand-authored", { disposition: "repaired" }),
    evidence("hand-authored", { probe_source: "hand_authored" }),
    finding("closed", { disposition: "repaired" }),
    evidence("closed", {}),
  ]);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, LEDGER);
    const frame = page.frameLocator("iframe.page-frame-iframe");

    await expect(frame.locator("body")).toHaveAttribute("data-state", "open");
    await expect(frame.locator("#summary")).toHaveText("6 findings · 1 unresolved · 4 evidence gaps");
    await expect(frame.locator(".finding")).toHaveCount(6);

    // Unresolved comes first, with the defect class visible rather than buried.
    const unresolved = frame.locator('[data-finding="review-findings/stale-read"]');
    await expect(unresolved).toBeVisible();
    await expect(unresolved.locator(".chip.disposition-unresolved")).toHaveText("unresolved");
    await expect(unresolved.locator(".defect-class")).toContainText("class of stale-read");
    await expect(unresolved.locator(".evidence .none")).toHaveText("No linked Repair Evidence.");
    await expect(unresolved).toHaveAttribute("data-gaps", "0");
    await expect(frame.locator("section").first().locator("h2")).toContainText("Unresolved");

    // A finding called repaired with nothing proving it.
    await expect(frame.locator('[data-finding="review-findings/no-evidence"] .gap')).toHaveText(
      "Disposition is repaired, but no Repair Evidence links to this finding.",
    );
    // A risk accepted without the rationale or owner the convention asks for.
    await expect(frame.locator('[data-finding="review-findings/no-rationale"] .gap')).toHaveCount(2);
    // Evidence that never ran red against the pre-repair implementation.
    await expect(frame.locator('[data-finding="review-findings/half-proven"] .gap')).toContainText(
      "never proven red against the pre-repair implementation",
    );
    await expect(
      frame.locator('[data-finding="review-findings/half-proven"] [data-evidence="repair-evidence/half-proven"] .proof.bad'),
    ).toHaveText("parent-red: missing");
    // A hand-authored probe is flagged, not silently accepted.
    await expect(frame.locator('[data-finding="review-findings/hand-authored"] .gap')).toContainText(
      "hand-authored",
    );

    // The one genuinely closed finding carries no gap and reports both proofs.
    const closed = frame.locator('[data-finding="review-findings/closed"]');
    await expect(closed).toHaveAttribute("data-gaps", "0");
    await expect(closed.locator(".proof.ok")).toHaveCount(3);
    await expect(closed.locator(".gap")).toHaveCount(0);
    await expect(frame.locator("#resolved")).toHaveCount(0);
  } finally {
    await ui.cleanup();
  }
});

test("the repair ledger reports the resolved state only when every finding is closed with complete proof", async ({ page }) => {
  const ui = await bootUiOverEngineeringReviewBundle([
    REVIEW,
    finding("stale-read", { disposition: "repaired" }),
    evidence("stale-read", {}),
    finding("accepted", { disposition: "accepted_risk", owner: "owner", rationale: "Tracked separately" }),
  ]);
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, LEDGER);
    const frame = page.frameLocator("iframe.page-frame-iframe");

    await expect(frame.locator("body")).toHaveAttribute("data-state", "resolved");
    await expect(frame.locator("#resolved")).toContainText("complete repair evidence");
    await expect(frame.locator("#summary")).toHaveText("2 findings · 0 unresolved · 0 evidence gaps");
    await expect(frame.locator(".gap")).toHaveCount(0);
    await expect(frame.locator('[data-finding="review-findings/stale-read"] .meta')).toContainText("Cache round 1");
  } finally {
    await ui.cleanup();
  }
});
