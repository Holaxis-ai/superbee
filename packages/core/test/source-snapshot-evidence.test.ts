import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotEvidence, assessSnapshotFreshness, type SnapshotEvidence } from "../src/source-engine/index.js";
const A = `sha256:${"a".repeat(64)}`, B = `sha256:${"b".repeat(64)}`;
const descriptor = (): SnapshotEvidence => ({ v: 1, association: "caller_asserted", inputs: [{ id: "model", sha256: A }], settings_digest: A,
  required_identities: [{ id: "model", sha256: B }] });

test("evidence descriptor is closed, versioned and bounded logical identities with exact digest spelling", () => {
  assert.deepEqual(parseSnapshotEvidence(descriptor()), descriptor());
  for (const patch of [{ v: 2 }, { association: "authenticated" }, { path: "/private" }, { inputs: [{ id: "../file", sha256: A }] },
    { inputs: [{ id: "model", sha256: A }, { id: "model", sha256: B }] }, { inputs: [{ id: "model", sha256: A, extra: true }] },
    { inputs: [{ id: "model", sha256: "a".repeat(64) }] }, { settings_digest: "sha256:bad" }, { required_identities: [{ id: "tool", sha256: A }, { id: "tool", sha256: A }] }]) {
    assert.throws(() => parseSnapshotEvidence({ ...descriptor(), ...patch }), { code: "SNAPSHOT_EVIDENCE_INVALID" });
  }
});

test("current requires a nonempty expected original input basis and every required dimension", () => {
  assert.equal(assessSnapshotFreshness(undefined, { inputs: {} }).status, "unverifiable");
  assert.equal(assessSnapshotFreshness({ v: 1, association: "caller_asserted", inputs: [] }, { inputs: {} }).reason, "no_input_basis");
  const observed = { inputs: { model: A }, required_identities: { model: B }, settings_digest: A };
  const result = assessSnapshotFreshness(descriptor(), observed);
  assert.equal(result.status, "current"); assert.equal(result.association, "caller_asserted"); assert.equal(result.basis, "declared_original_inputs");
  assert.deepEqual(result.rows.map(r => r.status), ["equal", "equal", "equal"]);
  assert.equal(assessSnapshotFreshness(descriptor(), { ...observed, settings_digest: undefined }).status, "unverifiable");
  assert.equal(assessSnapshotFreshness(descriptor(), { inputs: { model: A }, settings_digest: A }).status, "unverifiable");
  assert.equal(assessSnapshotFreshness(descriptor(), { ...observed, inputs: { model: null } }).status, "unverifiable");
  assert.equal(assessSnapshotFreshness(descriptor(), { ...observed, settings_digest: "invalid" }).status, "unverifiable");
});

test("known mismatch is stale with unknown rows retained; input and required-identity namespaces cannot alias", () => {
  const missingTool = assessSnapshotFreshness(descriptor(), { inputs: { model: B } });
  assert.equal(missingTool.status, "stale"); assert.deepEqual(missingTool.rows.map(r => r.status), ["mismatch", "unknown", "unknown"]);
  const alias = assessSnapshotFreshness(descriptor(), { inputs: { model: A }, settings_digest: A });
  assert.equal(alias.status, "unverifiable"); assert.equal(alias.rows[1]!.status, "unknown");
  const noBasis = assessSnapshotFreshness({ ...descriptor(), inputs: [] }, { inputs: {}, settings_digest: B });
  assert.equal(noBasis.status, "stale"); assert.equal(noBasis.reason, "known_mismatch");
});
