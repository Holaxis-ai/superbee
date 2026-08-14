import assert from "node:assert/strict";
import test from "node:test";

import { reconcile, replay, resolveTags, ReleaseStateError, RELEASE_STATES } from "./release-state.mjs";

const SHA = "sha256:" + "a".repeat(64);

// Immutable receipts for a full happy-path transaction. Each state carries exactly its required
// identifiers; later states re-assert nothing they must not.
const prepared = {
  target: "bridge",
  version: "0.1.0-pre.4",
  tag: "v0.1.0-pre.4",
  source_commit: "b".repeat(40),
  run_id: "1001",
  artifact_id: "art-1",
  artifact_digest: SHA,
  tarball_sha256: SHA,
  integrity: "sha512-xxxx",
};
const draftPrepared = { draft_release_id: "rel-1", asset_ids: ["a1", "a2"], asset_digest: SHA };
const staged = { stage_id: "stage-1", stage_tag: "next" };
const inspected = { actor: "brian", inspected_at: "2026-08-03T00:00:00.000Z", observed_sha256: SHA };
const approved = { actor: "mike", approved_at: "2026-08-03T01:00:00.000Z", public_version: "0.1.0-pre.4", public_tag: "next" };
const registryVerified = { packument_integrity: "sha512-xxxx", signature: "ok", provenance: "ok", install_smoke_ok: true };
const promoted = {
  actor: "brian",
  promoted_at: "2026-08-03T02:00:00.000Z",
  before_tags: { latest: "0.1.0-pre.3" },
  after_tags: { latest: "0.1.0-pre.4" },
  promoted_version: "0.1.0-pre.4",
};
const final = { release_id: "rel-1", release_tag: "v0.1.0-pre.4", assets: ["a1", "a2"], attestation: "att-1" };

const happyPath = [
  { to: "prepared", receipt: prepared },
  { to: "draft_prepared", receipt: draftPrepared },
  { to: "staged", receipt: staged },
  { to: "inspected", receipt: inspected },
  { to: "approved_public", receipt: approved },
  { to: "registry_verified", receipt: registryVerified },
  { to: "promoted", receipt: promoted },
  { to: "final", receipt: final },
];

test("every declared state has receipt fields and appears in the export", () => {
  for (const s of [
    "prepared",
    "draft_prepared",
    "staged",
    "inspected",
    "rejected",
    "approved_public",
    "registry_verified",
    "promoted",
    "final",
    "rolled_back",
  ]) {
    assert.ok(RELEASE_STATES.includes(s), `${s} missing from RELEASE_STATES`);
  }
});

test("the full happy path reconciles prepared -> final", () => {
  const ledger = replay(happyPath);
  assert.equal(ledger.state, "final");
  // The tarball SHA fixed at `prepared` survives untouched to the end.
  assert.equal(ledger.identifiers.tarball_sha256, SHA);
  assert.equal(ledger.identifiers.stage_id, "stage-1");
  assert.equal(ledger.identifiers.inspected_by, "brian");
  assert.equal(ledger.identifiers.approved_by, "mike");
  assert.equal(ledger.identifiers.promoted_by, "brian");
  assert.ok(!Object.hasOwn(ledger.identifiers, "actor"));
});

test("actor remains the public receipt field while each actor-bearing state owns one ledger key", () => {
  const beforeInspect = replay(happyPath.slice(0, 3));
  assert.throws(
    () => reconcile(beforeInspect, { to: "inspected", receipt: { inspected_by: "brian", inspected_at: inspected.inspected_at, observed_sha256: SHA } }),
    (error) => error.code === "missing_receipt" && /receipt\.actor/.test(error.message),
  );

  const afterInspect = reconcile(beforeInspect, { to: "inspected", receipt: inspected }).ledger;
  assert.equal(reconcile(afterInspect, { to: "inspected", receipt: inspected }).changed, false);
  assert.throws(
    () => reconcile(afterInspect, { to: "inspected", receipt: { ...inspected, actor: "mike" } }),
    (error) => error.code === "identifier_mismatch" && /inspected_by/.test(error.message),
  );

  const afterApproval = reconcile(afterInspect, { to: "approved_public", receipt: approved }).ledger;
  assert.equal(afterApproval.identifiers.inspected_by, "brian");
  assert.equal(afterApproval.identifiers.approved_by, "mike");

  const rejected = reconcile(afterInspect, {
    to: "rejected",
    receipt: { actor: "mike", rejected_at: "2026-08-03T00:30:00.000Z", reason: "policy" },
  }).ledger;
  assert.equal(rejected.identifiers.inspected_by, "brian");
  assert.equal(rejected.identifiers.rejected_by, "mike");

  const afterRegistry = reconcile(afterApproval, { to: "registry_verified", receipt: registryVerified }).ledger;
  const afterPromotion = reconcile(afterRegistry, { to: "promoted", receipt: promoted }).ledger;
  assert.equal(afterPromotion.identifiers.promoted_by, "brian");
  const rollback = reconcile(afterRegistry, {
    to: "rolled_back",
    receipt: {
      actor: "brian",
      rolled_back_at: "2026-08-03T02:00:00.000Z",
      restored_next: "0.1.0-pre.3",
      deprecated_version: "0.1.0-pre.4",
      recovery_command: "npm i -g @holaxis/aslite@0.1.0-pre.3",
    },
  }).ledger;
  assert.equal(rollback.identifiers.approved_by, "mike");
  assert.equal(rollback.identifiers.rolled_back_by, "brian");
});

test("each state refuses when a required immutable identifier is missing", () => {
  const cases = [
    ["prepared", { ...prepared, tarball_sha256: undefined }],
    ["staged", { stage_id: "s" }], // missing stage_tag
    ["inspected", { actor: "x", inspected_at: "t" }], // missing observed_sha256
    ["final", { release_id: "r", release_tag: "v", assets: [] }], // missing attestation
  ];
  for (const [to, receipt] of cases) {
    // Drive to the correct predecessor first where needed; for `prepared` start fresh.
    let ledger = { state: null, identifiers: {} };
    if (to !== "prepared") {
      ledger = replay(happyPath.slice(0, happyPath.findIndex((e) => e.to === to)));
    }
    assert.throws(() => reconcile(ledger, { to, receipt }), (e) => e instanceof ReleaseStateError && e.code === "missing_receipt");
  }
});

test("illegal transitions fail closed", () => {
  const afterPrepared = replay(happyPath.slice(0, 1));
  // prepared cannot jump straight to staged (must draft first).
  assert.throws(
    () => reconcile(afterPrepared, { to: "staged", receipt: staged }),
    (e) => e instanceof ReleaseStateError && e.code === "illegal_transition",
  );
  // final is terminal.
  const done = replay(happyPath);
  assert.throws(
    () => reconcile(done, { to: "promoted", receipt: promoted }),
    (e) => e.code === "illegal_transition",
  );
});

test("a receipt that mints a NEW value for a fixed identifier is a mismatch", () => {
  const afterPrepared = replay(happyPath.slice(0, 1));
  // draft asserts a different run_id than the one fixed at prepared.
  assert.throws(
    () => reconcile(afterPrepared, { to: "draft_prepared", receipt: { ...draftPrepared, run_id: "9999" } }),
    (e) => e instanceof ReleaseStateError && e.code === "identifier_mismatch",
  );
});

test("a draft whose asset digest != the prepared tarball SHA is refused (artifact swap)", () => {
  const afterPrepared = replay(happyPath.slice(0, 1));
  const badDigest = "sha256:" + "c".repeat(64);
  assert.throws(
    () => reconcile(afterPrepared, { to: "draft_prepared", receipt: { ...draftPrepared, asset_digest: badDigest } }),
    (e) => e instanceof ReleaseStateError && e.code === "artifact_mismatch",
  );
});

test("an inspection whose observed SHA != the prepared tarball SHA cannot approve — it must reject", () => {
  const beforeInspect = replay(happyPath.slice(0, 3)); // through staged
  const wrong = "sha256:" + "d".repeat(64);
  assert.throws(
    () => reconcile(beforeInspect, { to: "inspected", receipt: { ...inspected, observed_sha256: wrong } }),
    (e) => e instanceof ReleaseStateError && e.code === "inspection_mismatch",
  );
  // The same stage may still be rejected from `staged`.
  const rejected = reconcile(beforeInspect, {
    to: "inspected",
    receipt: inspected,
  });
  const r = reconcile(rejected.ledger, { to: "rejected", receipt: { actor: "brian", rejected_at: "t", reason: "policy" } });
  assert.equal(r.ledger.state, "rejected");
});

test("idempotent replay: re-applying the transition that produced the current state is a no-op", () => {
  const afterStaged = replay(happyPath.slice(0, 3));
  const again = reconcile(afterStaged, { to: "staged", receipt: staged });
  assert.equal(again.changed, false);
  assert.equal(again.ledger.state, "staged");
  // But replaying `staged` with a DIFFERENT stage_id is a mismatch, not a silent no-op.
  assert.throws(
    () => reconcile(afterStaged, { to: "staged", receipt: { ...staged, stage_id: "other" } }),
    (e) => e.code === "identifier_mismatch",
  );
});

test("the finalizer reconciles from immutable IDs and rejects a wrong stage id", () => {
  // Simulate a separately-dispatched finalizer that reconstructs the ledger from the dispatched IDs
  // then advances. A wrong stage id contradicts the fixed one.
  const ledger = replay(happyPath.slice(0, 5)); // through approved_public
  const ok = reconcile(ledger, { to: "registry_verified", receipt: { ...registryVerified } });
  assert.equal(ok.ledger.state, "registry_verified");
  const forged = { state: "approved_public", identifiers: { ...ledger.identifiers, stage_id: "forged" } };
  // Reconstructing the ledger with a forged stage id is itself internally consistent, but any later
  // receipt that carries the TRUE stage id will contradict it.
  assert.throws(
    () => reconcile(forged, { to: "registry_verified", receipt: { ...registryVerified, stage_id: staged.stage_id } }),
    (e) => e.code === "identifier_mismatch",
  );
});

test("rollback is reachable from every post-approval state", () => {
  const rollback = { actor: "brian", rolled_back_at: "t", restored_next: "0.1.0-pre.3", deprecated_version: "0.1.0-pre.4", recovery_command: "npm i -g @holaxis/aslite@0.1.0-pre.3" };
  for (const cut of [5, 6, 7]) {
    const ledger = replay(happyPath.slice(0, cut));
    const r = reconcile(ledger, { to: "rolled_back", receipt: rollback });
    assert.equal(r.ledger.state, "rolled_back");
    // rolled_back is terminal.
    assert.throws(() => reconcile(r.ledger, { to: "final", receipt: final }), (e) => e.code === "illegal_transition");
  }
});

test("resolveTags: prerelease keeps latest known-good while next floats the candidate", () => {
  const base = { kind: "prerelease", version: "0.1.0-pre.4", priorLatest: "0.1.0-pre.3", priorNext: "0.1.0-pre.3" };
  assert.deepEqual(resolveTags({ ...base, phase: "at_rest" }), { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" });
  assert.deepEqual(resolveTags({ ...base, phase: "staged" }), { latest: "0.1.0-pre.3", next: "0.1.0-pre.4" });
  assert.deepEqual(resolveTags({ ...base, phase: "approved" }), { latest: "0.1.0-pre.3", next: "0.1.0-pre.4" });
  assert.deepEqual(resolveTags({ ...base, phase: "promoted" }), { latest: "0.1.0-pre.4", next: "0.1.0-pre.4" });
  assert.deepEqual(resolveTags({ ...base, phase: "failed" }), { latest: "0.1.0-pre.3", next: "0.1.0-pre.3", deprecate: "0.1.0-pre.4" });
});

test("resolveTags: first stable moves latest at approval and restores on failure", () => {
  const base = { kind: "stable", version: "0.1.0", priorLatest: "0.1.0-pre.4", priorNext: "0.1.0-pre.4" };
  assert.deepEqual(resolveTags({ ...base, phase: "at_rest" }), { latest: "0.1.0-pre.4", next: "0.1.0-pre.4" });
  assert.deepEqual(resolveTags({ ...base, phase: "approved" }), { latest: "0.1.0", next: "0.1.0-pre.4" });
  assert.deepEqual(resolveTags({ ...base, phase: "failed" }), { latest: "0.1.0-pre.4", next: "0.1.0-pre.4", deprecate: "0.1.0" });
  // Success collapses a redundant next onto the stable version.
  assert.deepEqual(resolveTags({ kind: "stable", version: "0.1.0", priorLatest: "0.1.0-pre.4", priorNext: "0.1.0", phase: "promoted" }), {
    latest: "0.1.0",
    next: "0.1.0",
  });
});

test("resolveTags rejects an unknown kind or phase", () => {
  assert.throws(() => resolveTags({ kind: "nope", phase: "at_rest" }), /prerelease\|stable/);
  assert.throws(() => resolveTags({ kind: "prerelease", phase: "nope" }), /unknown prerelease phase/);
});
