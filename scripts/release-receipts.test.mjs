import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStageReceipt,
  parseStagePublishJson,
  stageDownloadFilename,
  verifyFinalizerChain,
} from "./release-receipts.mjs";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../packages/cli/src/integration-guidance.js";
import { buildReceipt, renderReceiptMarkdown } from "./release-emit-receipt.mjs";

const STAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const VERSION = "0.1.0-pre.4";
const COMMIT = "1".repeat(40);
const TARBALL_SHA = "sha256:" + "a".repeat(64);
const MANIFEST_SHA = "sha256:" + "b".repeat(64);
const CANDIDATE_ARTIFACT_DIGEST = "sha256:" + "c".repeat(64);
const RECEIPT_ARTIFACT_DIGEST = "sha256:" + "d".repeat(64);
const INTEGRITY = "sha512-YWJjZA==";
const TARBALL = `holaxis-aslite-${VERSION}.tgz`;
const TARGET = "bridge";

test("npm 11.15 stage JSON yields exactly one validated UUID stageId", () => {
  assert.equal(parseStagePublishJson(JSON.stringify({ "@holaxis/aslite": { stageId: STAGE_ID } })), STAGE_ID);
  assert.throws(() => parseStagePublishJson("not-json"), /valid JSON/);
  assert.throws(() => parseStagePublishJson(JSON.stringify({ ok: true })), /exactly one stageId/);
  assert.throws(
    () => parseStagePublishJson(JSON.stringify([{ stageId: STAGE_ID }, { stageId: STAGE_ID } ])),
    /exactly one stageId/,
  );
  assert.throws(() => parseStagePublishJson(JSON.stringify({ stageId: "not-a-uuid" })), /invalid stageId/);
});

test("stage download uses npm's deterministic filename and no invented --out path", () => {
  assert.equal(stageDownloadFilename(TARGET, VERSION, STAGE_ID), `holaxis-aslite-${VERSION}-${STAGE_ID}.tgz`);
});

test("declared rehearsal targets resolve from the manifest but cannot enter the full stage receipt chain", () => {
  assert.throws(
    () => buildStageReceipt({ target: "rehearsal-reject", version: "0.0.0-rename-reject.20260812", stageId: STAGE_ID }),
    /requires workflow contract full/,
  );
});

function fixture() {
  const draftAssets = [
    { id: "201", name: TARBALL, digest: TARBALL_SHA },
    { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
  ];
  const receipt = buildStageReceipt({
    target: "bridge",
    runId: "100",
    artifactId: "101",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: TARBALL,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets,
  });
  const candidate = {
    schema: "superbee.release-candidate.v1",
    target: "bridge",
    package: { name: "@holaxis/aslite" },
    tag: `v${VERSION}`,
    version: VERSION,
    source: { commit: COMMIT, dirty: false },
    tarball: { filename: TARBALL, sha256: TARBALL_SHA, integrity: INTEGRITY },
  };
  const dispatch = {
    runId: "100",
    artifactId: "101",
    stageReceiptArtifactId: "102",
    stageReceiptArtifactDigest: RECEIPT_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    draftReleaseId: "300",
    version: VERSION,
  };
  return {
    candidate,
    receipt,
    candidateArtifact: {
      id: 101,
      name: "release-candidate-100",
      digest: CANDIDATE_ARTIFACT_DIGEST,
      expired: false,
      workflow_run: { id: 100, head_sha: COMMIT },
    },
    receiptArtifact: {
      id: 102,
      name: "release-stage-receipt-100",
      digest: RECEIPT_ARTIFACT_DIGEST,
      expired: false,
      workflow_run: { id: 100, head_sha: COMMIT },
    },
    release: { id: 300, draft: true, tag_name: `v${VERSION}`, assets: draftAssets },
    dispatch,
    actualTarballSha256: TARBALL_SHA,
    actualManifestSha256: MANIFEST_SHA,
  };
}

test("finalizer accepts only a fully matching candidate/artifact/stage/draft chain", () => {
  const proof = verifyFinalizerChain(fixture());
  assert.equal(proof.stage_id, STAGE_ID);
  assert.equal(proof.tarball_sha256, TARBALL_SHA);
  assert.deepEqual(proof.core_assets, [
    { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
    { id: "201", name: TARBALL, digest: TARBALL_SHA },
  ]);
});

test("stage summary and retained JSON are emitted from the same v2 receipt", () => {
  const f = fixture();
  const built = buildReceipt({
    target: TARGET,
    runId: "100",
    artifactId: "101",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: TARBALL,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets: f.release.assets,
  });
  assert.equal(built.receipt.schema, "superbee.stage-receipt.v1");
  assert.equal(built.receipt.stage.id, STAGE_ID);
  assert.equal(built.inspection.steps[0], `npm stage download ${STAGE_ID}`);
  assert.ok(!built.inspection.steps.some((step) => step.includes("--out")));
});

test("stage summary carries the bounded stable MCP launch migration guidance", () => {
  const f = fixture();
  const built = buildReceipt({
    target: TARGET,
    runId: "100",
    artifactId: "101",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: TARBALL,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets: f.release.assets,
  });
  const summary = renderReceiptMarkdown(built);
  assert.equal((summary.match(/## Stable MCP launch/g) ?? []).length, 1);
  assert.match(summary, /npm install -g superbee/);
  assert.match(summary, /host command `superbee` with first argument `mcp`/);
  assert.match(summary, /superbee version --json/);
  assert.match(summary, /does not scan or rewrite host MCP configuration/);
  assert.ok(summary.endsWith(STABLE_MCP_LAUNCH_GUIDANCE), "receipt consumes the shared guidance authority exactly");
  assert.ok(!Object.hasOwn(built.receipt, "guidance"), "immutable receipt schema remains unchanged");
});

test("finalizer tolerates only strict live-UUID current/sibling auxiliaries; malformed lookalikes stay red", () => {
  // Valid current/sibling auxiliaries may coexist on the mutable draft; the core two stay exact.
  const withReceipts = fixture();
  withReceipts.release.assets = [
    ...withReceipts.release.assets,
    { id: "401", name: `receipt-inspected-${STAGE_ID}.json`, digest: "sha256:" + "1".repeat(64) },
    { id: "402", name: `receipt-approved-${STAGE_ID}.json`, digest: "sha256:" + "2".repeat(64) },
    { id: "403", name: `receipt-status-${STAGE_ID}.json`, digest: "sha256:" + "3".repeat(64) },
    { id: "404", name: "receipt-status-223e4567-e89b-42d3-a456-426614174000.json", digest: "sha256:" + "4".repeat(64) },
  ];
  assert.equal(verifyFinalizerChain(withReceipts).stage_id, STAGE_ID);

  for (const name of ["extra.tgz", "receipt-status-0000.json", "receipt-approved-dry-run-stage.json", `receipt-forged-${STAGE_ID}.json`]) {
    const malformed = fixture();
    malformed.release.assets = [...malformed.release.assets, { id: "405", name, digest: "sha256:" + "5".repeat(64) }];
    assert.throws(() => verifyFinalizerChain(malformed), /release receipt verification failed/, name);
  }
});

test("finalizer rejects ignored/swapped immutable identifiers and assets", () => {
  for (const mutate of [
    (f) => (f.dispatch.artifactId = "999"),
    (f) => (f.dispatch.stageId = "223e4567-e89b-42d3-a456-426614174000"),
    (f) => (f.candidateArtifact.workflow_run.head_sha = "2".repeat(40)),
    (f) => (f.receiptArtifact.digest = "sha256:" + "e".repeat(64)),
    (f) => (f.actualTarballSha256 = "sha256:" + "f".repeat(64)),
    (f) => (f.release.assets[0].digest = "sha256:" + "0".repeat(64)),
    (f) => (f.release.draft = false),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => verifyFinalizerChain(f), /release receipt verification failed/);
  }
});

// Regression: actions/upload-artifact emits a BARE hex digest, while the Actions REST API the
// finalizer reads reports the same value as sha256:<hex>. The fixtures above use the API form, so
// the suite was green while the real workflow died on its first live contact with the action's
// output. These tests use the shape GitHub actually produces.
const ACTION_BARE_DIGEST = "c".repeat(64);

test("a bare hex artifact digest (the actions/upload-artifact output shape) is canonicalized", () => {
  const receipt = buildStageReceipt({
    target: TARGET,
    runId: "100",
    artifactId: "101",
    artifactDigest: ACTION_BARE_DIGEST,
    stageId: STAGE_ID,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: TARBALL,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets: [
      { id: "201", name: TARBALL, digest: TARBALL_SHA },
      { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
    ],
  });
  // Stored in the API's form so the finalizer's equality check against artifact metadata holds.
  assert.equal(receipt.prepared.artifact.digest, `sha256:${ACTION_BARE_DIGEST}`);
  assert.equal(receipt.prepared.artifact.digest, CANDIDATE_ARTIFACT_DIGEST);
});

test("a bare hex stage-receipt artifact digest dispatch input verifies against prefixed API metadata", () => {
  const f = fixture();
  assert.equal(f.receiptArtifact.digest, RECEIPT_ARTIFACT_DIGEST);
  f.dispatch.stageReceiptArtifactDigest = RECEIPT_ARTIFACT_DIGEST.replace("sha256:", "");
  assert.doesNotThrow(() => verifyFinalizerChain(f));
});

test("canonicalization does not weaken the digest guard", () => {
  for (const bad of ["sha256:" + "z".repeat(64), "c".repeat(63), "c".repeat(65), "sha256:", "", null]) {
    assert.throws(
      () => buildStageReceipt({
        target: TARGET,
        runId: "100", artifactId: "101", artifactDigest: bad, stageId: STAGE_ID, version: VERSION,
        tag: `v${VERSION}`, sourceCommit: COMMIT, policyTag: "next", tarballSha256: TARBALL_SHA,
        tarballFilename: TARBALL, integrity: INTEGRITY, manifestSha256: MANIFEST_SHA,
        draftReleaseId: "300", draftAssets: [],
      }),
      /invalid candidate artifact digest/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

// Regression: the pre.5 dry run died AFTER receipt validation, in receiptEmissionCommands, which
// demanded a UUID stage id while dry-run mode substitutes the "dry-run-stage" sentinel — a
// validator disagreement between buildStageReceipt (sentinel-aware) and the command renderer
// (not). This exercises buildReceipt — the exact entry the workflow's stage job calls — with the
// full dry-run field shape from the failed run, through markdown rendering.
test("buildReceipt completes for a DRY RUN (sentinel stage id) end to end", () => {
  const built = buildReceipt({
    target: TARGET,
    runId: "31445190599",
    artifactId: "9082708155",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: "dry-run-stage",
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: TARBALL,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "dry-run-release",
    draftAssets: [
      { id: "dry-run-tarball", name: TARBALL, digest: TARBALL_SHA },
      { id: "dry-run-manifest", name: "candidate.json", digest: MANIFEST_SHA },
    ],
  });
  assert.equal(built.receipt.stage.id, "dry-run-stage");
  assert.equal(built.receipt.stage.download_filename, null);
  assert.match(built.receipt_emission.inspected, /--stage-id dry-run-stage/);
  const markdown = renderReceiptMarkdown(built);
  assert.match(markdown, /dry-run-stage/);
});

test("a live receipt still refuses a non-UUID, non-sentinel stage id", () => {
  assert.throws(
    () => buildReceipt({
      target: TARGET,
      runId: "100", artifactId: "101", artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
      stageId: "not-a-uuid", version: VERSION, tag: `v${VERSION}`, sourceCommit: COMMIT,
      policyTag: "next", tarballSha256: TARBALL_SHA, tarballFilename: TARBALL,
      integrity: INTEGRITY, manifestSha256: MANIFEST_SHA, draftReleaseId: "300",
      draftAssets: [
        { id: "201", name: TARBALL, digest: TARBALL_SHA },
        { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
      ],
    }),
    /invalid stage id/,
  );
});
