import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { verifyModelingInterviewDelivery } from "../../../scripts/modeling-interview-contract.mjs";

const NOVICE_MODELING_SCENARIO = JSON.parse(readFileSync(
  new URL("../../../examples/references/modeling-interview-contract-v1.json", import.meta.url),
  "utf8",
));

function failureIds(proposal: unknown, delivery: unknown): string[] {
  return verifyModelingInterviewDelivery(proposal, delivery).failures.map(({ id }) => id);
}

test("the synthetic novice Assignment/Research receipt satisfies the approved manifest", () => {
  const result = verifyModelingInterviewDelivery(
    NOVICE_MODELING_SCENARIO.proposal,
    NOVICE_MODELING_SCENARIO.delivery,
  );
  assert.deepEqual(result, { passed: true, failures: [] });
});

test("the novice verifier rejects an overview substituted for approved representative records", () => {
  const delivery = structuredClone(NOVICE_MODELING_SCENARIO.delivery);
  delivery.delivered_record_ids = ["docs/workspace-overview"];
  assert.ok(
    failureIds(NOVICE_MODELING_SCENARIO.proposal, delivery).includes("delivery.overview_substitution"),
  );
});

test("the novice verifier rejects a Kind installation absent from the approved proposal", () => {
  const delivery = structuredClone(NOVICE_MODELING_SCENARIO.delivery);
  delivery.installed_kind_names.push("CRM Contact");
  assert.ok(
    failureIds(NOVICE_MODELING_SCENARIO.proposal, delivery).includes("delivery.unsupported_kind_installation"),
  );
});

test("the novice verifier rejects postapproval install/defer drift", () => {
  const delivery = structuredClone(NOVICE_MODELING_SCENARIO.delivery);
  const research = delivery.kind_dispositions.find(({ kind }: { kind: string }) => kind === "Research");
  assert.ok(research);
  research.disposition = "install_now";
  delete research.stabilizing_trigger;
  research.declared_structure = ["field:source"];
  research.evidence_sources = [{ class: "prior_record", id: "interview-intention:research-will-recur" }];
  delivery.installed_kind_names.push("Research");
  assert.ok(
    failureIds(NOVICE_MODELING_SCENARIO.proposal, delivery).includes("delivery.kind_disposition_drift"),
  );
});

test("install-now evidence covers only the structure actually proposed", () => {
  const proposal = structuredClone(NOVICE_MODELING_SCENARIO.proposal);
  const assignment = proposal.categories.candidate_kinds.find(
    ({ kind }: { kind: string }) => kind === "Assignment",
  );
  assert.ok(assignment);
  assert.deepEqual(assignment.declared_structure, ["field:status", "field:source"]);
  assert.equal("lifecycle" in assignment, false);
  assert.equal("relationships" in assignment, false);
  assert.equal(
    failureIds(proposal, NOVICE_MODELING_SCENARIO.delivery).includes("proposal.kind_evidence_incomplete"),
    false,
  );

  assignment.evidence.supports = ["field:status"];
  assert.ok(
    failureIds(proposal, NOVICE_MODELING_SCENARIO.delivery).includes("proposal.kind_evidence_incomplete"),
  );

  const intentionOnly = structuredClone(NOVICE_MODELING_SCENARIO.proposal);
  intentionOnly.categories.candidate_kinds[0].evidence.sources = [
    { class: "intention", id: "Assignment will recur" },
  ];
  assert.ok(
    failureIds(intentionOnly, NOVICE_MODELING_SCENARIO.delivery).includes("proposal.kind_evidence_missing"),
  );
});
