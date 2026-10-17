/**
 * Every Signal the planner builds from honest input is written: the Signal guards accept exactly
 * the planner's rendering. Each case plans from record changes or findings and applies the plan as
 * built, on both editions: text with line breaks, many related documents, a backtick in a record
 * id, a space in a feed id, and a correlation reason with a line break.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Frontmatter } from "../src/types.js";
import {
  applyRecordOverlay,
  planFindings,
  planRecordOverlay,
  readOverlayPolicy,
  type OverlayHooks,
  type OverlayPlan,
  type OverlayPolicy,
  type RecordChange,
} from "../src/record-overlay/index.js";
import { ACTOR, change, DIGEST, EDITOR_BODY, event, FEED_FRONTMATTER, overlayWorld, PROVIDER, UID, type World } from "./record-overlay-helpers.js";

const AT = "2026-10-03T14:00:00Z";
const BREAKS = { lf: "Room A\nupstairs", crlf: "Room A\r\nupstairs", nel: "Room A\u0085upstairs", ls: "Room A\u2028upstairs", ps: "Room A\u2029upstairs" };

async function run(w: World, changes: RecordChange[], options: { policy?: OverlayPolicy; observedAt?: string; hooks?: OverlayHooks } = {}) {
  const policy = options.policy ?? w.policy;
  const plan = await planRecordOverlay({ content: w.content, ops: w.ops, policy, changes, observedAt: options.observedAt ?? AT, sameBundle: true, hooks: options.hooks });
  const receipt = await applyRecordOverlay(plan, { content: w.content, ops: w.ops, policy, actor: ACTOR });
  return { plan, receipt };
}
const outcomes = (receipt: { results: Array<{ op: string; outcome: string; code?: string }> }) => receipt.results.map((r) => [r.op, r.outcome, r.code]);
async function signalBody(w: World, target: string): Promise<string> {
  return (await w.read(target, "ops")).doc.body;
}

for (const edition of ["0.1", "0.2"] as const) {
  test(`(${edition}) a new record whose owned text holds any line break raises its Signal; a later change collapses into it`, async () => {
    for (const [name, text] of Object.entries(BREAKS)) {
      const w = await overlayWorld({ edition });
      const created = await run(w, [change(UID("201"), "new", null, { title: "Fair", start: "2026-11-01T10:00:00-04:00", venue_text: text }, DIGEST("1"))]);
      assert.deepEqual(outcomes(created.receipt), [["create-signal", "applied", undefined]], name);
      const target = created.receipt.results[0]!.target!;
      assert.ok((await signalBody(w, target)).includes(text), name);
      const later = `${text} and the hall`;
      const collapsed = await run(w, [change(UID("201"), "changed", { title: "Fair", venue_text: text }, { title: "Fair", venue_text: later }, DIGEST("2"))], { observedAt: "2026-10-04T14:00:00Z" });
      assert.deepEqual(outcomes(collapsed.receipt), [["collapse-signal", "applied", undefined]], name);
      assert.ok((await signalBody(w, target)).includes(later), name);
    }
  });

  test(`(${edition}) a record id holding a backtick raises its Signal with the adoption hint`, async () => {
    const w = await overlayWorld({ edition });
    const { receipt } = await run(w, [change("o`neill-1", "new", null, { title: "Recital" }, DIGEST("3"))]);
    assert.deepEqual(outcomes(receipt), [["create-signal", "applied", undefined]]);
    assert.match(await signalBody(w, receipt.results[0]!.target!), /`id: o`neill-1`\./);
  });

  test(`(${edition}) a feed id holding a space links its Signals to the feed`, async () => {
    const w = await overlayWorld({ edition });
    const policy = readOverlayPolicy({ id: "source-feeds/synthetic library", frontmatter: FEED_FRONTMATTER as unknown as Frontmatter }, { targetKind: w.content.registry.kinds.get("Event")! });
    const { receipt } = await run(w, [change(UID("202"), "new", null, { title: "Book Swap" }, DIGEST("4"))], { policy });
    assert.deepEqual(outcomes(receipt), [["create-signal", "applied", undefined]]);
    assert.match(await signalBody(w, receipt.results[0]!.target!), /^\[from feed\]\(\.\.\/source-feeds\/synthetic library\.md\)$/m);
  });

  test(`(${edition}) a correlation reason holding a line break is kept to one line and the Signal is written`, async () => {
    const w = await overlayWorld({ edition });
    await w.put("events/corner", event("777", { title: "Corner", start: "2026-10-10T10:00:00-04:00" }), EDITOR_BODY);
    const correlate = { kind: "Event", match: () => ({ reason: "same street\naddress", priority: "urgent" }) };
    const { receipt } = await run(w, [change(UID("203"), "new", null, { title: "Licence" }, DIGEST("5"))], { hooks: { correlate } });
    assert.deepEqual(outcomes(receipt), [["create-signal", "applied", undefined]]);
    assert.match(await signalBody(w, receipt.results[0]!.target!), /^Related document \(content bundle\): `events\/corner` \(same street address\)$/m);
  });

  test(`(${edition}) findings with line breaks, nine or more related Places, and odd related values are all written`, async () => {
    const w = await overlayWorld({ edition });
    const places = Array.from({ length: 10 }, (_, i) => `places/unit-${i + 1}-5-example-st`);
    const findings = [
      { key: "facility/new-1", title: "New facility at 5 Example St", summary: "A new food service permit\nat an address with ten Places", facts: { permit: "p-1" }, about_doc: places[0], related: places },
      { key: "facility/new-2", title: "Odd related values", summary: "Related values that are not document ids", facts: { permit: "p-2" }, related: ["places/o`neill-pub", "../escape", "", "places/two words"] },
      { key: "facility/new-3", title: "Nine related", summary: "nine", facts: { permit: "p-3" }, related: places.slice(0, 9) },
    ];
    const steps = await planFindings({ ops: w.ops, provider: "process:health-review", slug: "health", findings, observedAt: AT });
    const plan: OverlayPlan = { feed: null, provider: "process:health-review", observed_at: AT, steps, refusals: [] };
    const receipt = await applyRecordOverlay(plan, { content: w.ops, ops: w.ops, policy: { owned_fields: [], provider: "process:health-review" }, actor: ACTOR });
    assert.deepEqual(outcomes(receipt), [["create-signal", "applied", undefined], ["create-signal", "applied", undefined], ["create-signal", "applied", undefined]]);
    const first = await signalBody(w, receipt.results[0]!.target!);
    assert.equal(first.match(/^Related document \(content bundle\): /gm)!.length, 10);
    assert.ok(first.includes("A new food service permit\nat an address with ten Places"));
    const odd = await signalBody(w, receipt.results[1]!.target!);
    assert.deepEqual(odd.match(/^Related document .*$/gm), ["Related document (content bundle): `places/o`neill-pub`", "Related document (content bundle): `places/two words`"]);
    const again = await planFindings({ ops: w.ops, provider: "process:health-review", slug: "health", findings: [{ ...findings[0]!, facts: { permit: "p-1", moved: true } }], observedAt: "2026-10-04T14:00:00Z" });
    const collapse = await applyRecordOverlay({ ...plan, observed_at: "2026-10-04T14:00:00Z", steps: again }, { content: w.ops, ops: w.ops, policy: { owned_fields: [], provider: "process:health-review" }, actor: ACTOR });
    assert.deepEqual(outcomes(collapse), [["collapse-signal", "applied", undefined]]);
  });
}

test("the planner's text helpers keep H&M's bytes for ordinary input", async () => {
  const w = await overlayWorld();
  const { plan } = await run(w, [change(UID("204"), "new", null, { title: "Story", start: "2026-11-01T10:00:00-04:00" }, DIGEST("6"))]);
  const step = plan.steps[0] as { candidate: { body: string } };
  assert.equal(step.candidate.body, [
    "[from feed](../source-feeds/synthetic-library.md)",
    "",
    `To overlay this record, give a document of Kind "Event" the source entry \`resource: ${PROVIDER}\`, \`id: ${UID("204")}\`.`,
    "",
    "# Observations",
    "",
    `- ${AT} · new · ${DIGEST("6")} · new record @ 2026-11-01T10:00:00-04:00`,
    "",
  ].join("\n"));
});
