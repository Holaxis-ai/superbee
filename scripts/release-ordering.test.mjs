import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReceiptStatusStamp,
  buildPublicationPlan,
  canonicalPayloadBytes,
  canonicalReceiptPayload,
  evaluateOrdering,
  normalizeReceiptStatusBody,
  parseAuxiliaryReleaseAssetName,
  parseReceiptFile,
  policyTagFor,
  receiptAssetName,
  receiptEmissionCommands,
  releaseTier,
  SIGN_NAMESPACE,
  stampAnnotation,
  stampAssetName,
  verifyFinalPublication,
  verifyReceiptStatusBody,
} from "./release-ordering.mjs";
import {
  allowedSignerPrincipals,
  applyPublicationPlan,
  main as verifyOrderingMain,
  selectReceiptAssets,
  verifySignedReceipt,
} from "./release-verify-ordering.mjs";
import { buildStageReceipt } from "./release-receipts.mjs";
import { ReleaseStateError } from "./release-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_STAGE_ID = "223e4567-e89b-42d3-a456-426614174000";
const COMMIT = "1".repeat(40);
const TARBALL_SHA = "sha256:" + "a".repeat(64);
const OTHER_SHA = "sha256:" + "9".repeat(64);
const MANIFEST_SHA = "sha256:" + "b".repeat(64);
const INTEGRITY = "sha512-YWJjZA==";
const RUN_CREATED_AT = "2026-08-08T12:00:00Z";
const ALLOWED = ["briand-ai", "mikec-ai"];

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stageReceiptFor(version) {
  const tarball = `holaxis-aslite-${version}.tgz`;
  return buildStageReceipt({
    runId: "100",
    artifactId: "101",
    artifactDigest: "sha256:" + "c".repeat(64),
    stageId: STAGE_ID,
    version,
    tag: `v${version}`,
    sourceCommit: COMMIT,
    policyTag: policyTagFor(version),
    tarballSha256: TARBALL_SHA,
    tarballFilename: tarball,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets: [
      { id: "201", name: tarball, digest: TARBALL_SHA },
      { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
    ],
  });
}

function chainFor(version) {
  return {
    schema: "aslite.finalizer-chain-proof.v1",
    version,
    tag: `v${version}`,
    source_commit: COMMIT,
    stage_id: STAGE_ID,
    draft_release_id: "300",
    tarball_sha256: TARBALL_SHA,
    integrity: INTEGRITY,
    core_assets: [
      { id: 202, name: "candidate.json", digest: MANIFEST_SHA },
      { id: 201, name: `holaxis-aslite-${version}.tgz`, digest: TARBALL_SHA },
    ],
  };
}

function receiptFor(decision, version, overrides = {}, meta = {}) {
  const payload = canonicalReceiptPayload({
    decision,
    stage_id: STAGE_ID,
    version,
    tarball_sha256: TARBALL_SHA,
    draft_release_id: "300",
    actor: "briand-ai",
    emitted_at: decision === "inspected" ? "2026-08-08T10:00:00Z" : "2026-08-08T10:30:00Z",
    ...(decision === "inspected" ? { observed_sha256: TARBALL_SHA } : {}),
    ...overrides,
  });
  return {
    payload,
    uploaderLogin: meta.uploaderLogin ?? payload.actor,
    uploadedAt: meta.uploadedAt ?? (decision === "inspected" ? "2026-08-08T10:01:00Z" : "2026-08-08T10:31:00Z"),
    asset: meta.asset ?? {
      id: decision === "inspected" ? 401 : 402,
      name: receiptAssetName(decision, STAGE_ID),
      digest: decision === "inspected" ? `sha256:${"1".repeat(64)}` : `sha256:${"2".repeat(64)}`,
    },
  };
}

function evaluate(version, { mode = "live", inspected, approved } = {}) {
  return evaluateOrdering({
    mode,
    chain: chainFor(version),
    stageReceipt: stageReceiptFor(version),
    inspected: inspected === undefined ? receiptFor("inspected", version) : inspected,
    approved: approved === undefined ? receiptFor("approved", version) : approved,
    runCreatedAt: RUN_CREATED_AT,
    allowedActors: ALLOWED,
  });
}

const PRE = "0.1.0-pre.4";
const STABLE = "0.1.0";

test("payload shape: canonical, ordered, validated", () => {
  const a = canonicalReceiptPayload({
    emitted_at: "2026-08-08T10:00:00Z",
    actor: "briand-ai",
    observed_sha256: TARBALL_SHA,
    draft_release_id: "300",
    tarball_sha256: TARBALL_SHA,
    version: PRE,
    stage_id: STAGE_ID,
    decision: "inspected",
  });
  const b = canonicalReceiptPayload({
    decision: "inspected",
    stage_id: STAGE_ID,
    version: PRE,
    tarball_sha256: TARBALL_SHA,
    draft_release_id: "300",
    actor: "briand-ai",
    emitted_at: "2026-08-08T10:00:00Z",
    observed_sha256: TARBALL_SHA,
  });
  assert.equal(canonicalPayloadBytes(a), canonicalPayloadBytes(b), "field order in input never changes signed bytes");
  assert.deepEqual(Object.keys(a), [
    "schema", "decision", "stage_id", "version", "tarball_sha256", "draft_release_id", "actor", "emitted_at", "observed_sha256",
  ]);
  for (const bad of [
    { decision: "published" },
    { version: "not-semver" },
    { tarball_sha256: "a".repeat(64) },
    { actor: "briand ai" },
    { emitted_at: "yesterday" },
    { schema: "aslite.operator-receipt.v2" },
  ]) {
    assert.throws(() => canonicalReceiptPayload({ ...a, ...bad }), /operator receipt verification failed/);
  }
  assert.throws(
    () => canonicalReceiptPayload({ ...a, decision: "approved" }),
    /must not carry observed_sha256/,
    "approved receipts carry no observation claim",
  );
});

test("tier + naming authorities", () => {
  assert.equal(releaseTier(PRE), "prerelease");
  assert.equal(releaseTier(STABLE), "stable");
  assert.equal(releaseTier("1.0.0+build-1"), "stable", "a hyphen in build metadata does not make a prerelease");
  assert.equal(releaseTier("1.0.0-pre.1+build-1"), "prerelease", "prerelease identity survives build metadata");
  assert.equal(policyTagFor(PRE), "next");
  assert.equal(policyTagFor(STABLE), "latest");
  assert.equal(policyTagFor("1.0.0+build-1"), "latest");
  assert.equal(receiptAssetName("inspected", STAGE_ID), `receipt-inspected-${STAGE_ID}.json`);
  assert.equal(stampAssetName(STAGE_ID), `receipt-status-${STAGE_ID}.json`);
  assert.ok(parseAuxiliaryReleaseAssetName(`receipt-approved-${STAGE_ID}.json`, { mode: "pre-stage" }));
  assert.ok(parseAuxiliaryReleaseAssetName(`receipt-status-${STAGE_ID}.json`, { mode: "pre-stage" }));
  assert.equal(parseAuxiliaryReleaseAssetName("evil.tgz", { mode: "pre-stage" }), null);
  assert.equal(parseAuxiliaryReleaseAssetName("receipt-forged-x.json", { mode: "pre-stage" }), null);
  assert.equal(parseAuxiliaryReleaseAssetName("receipt-approved-dry-run-stage.json", { mode: "pre-stage" }), null);
  assert.equal(parseAuxiliaryReleaseAssetName("candidate.json", { mode: "pre-stage" }), null);
  assert.throws(() => receiptAssetName("status", STAGE_ID), /unknown receipt decision/);
  assert.deepEqual(
    parseAuxiliaryReleaseAssetName(`receipt-approved-${OTHER_STAGE_ID}.json`, { mode: "pre-stage" }),
    { name: `receipt-approved-${OTHER_STAGE_ID}.json`, decision: "approved", stage_id: OTHER_STAGE_ID, category: "residual" },
  );
  assert.equal(
    parseAuxiliaryReleaseAssetName(`receipt-status-${STAGE_ID}.json`, { mode: "finalize", currentStageId: STAGE_ID }).category,
    "current_status",
  );
  assert.equal(
    parseAuxiliaryReleaseAssetName(`receipt-inspected-${OTHER_STAGE_ID}.json`, { mode: "finalize", currentStageId: STAGE_ID }).category,
    "sibling",
  );
  assert.equal(parseAuxiliaryReleaseAssetName("receipt-status-0000.json", { mode: "pre-stage" }), null);
  assert.throws(() => parseAuxiliaryReleaseAssetName("candidate.json", { mode: "unknown" }), /unknown auxiliary classification mode/);
  assert.throws(
    () => parseAuxiliaryReleaseAssetName("candidate.json", { mode: "finalize", currentStageId: "dry-run-stage" }),
    /invalid current stage id/,
  );
});

test("TIER MATRIX — prerelease with both receipts reaches approved_public, no stamp", () => {
  const result = evaluate(PRE);
  assert.equal(result.tier, "prerelease");
  assert.equal(result.state, "approved_public");
  assert.deepEqual(result.missing, []);
  assert.equal(result.stamp_required, false);
  assert.deepEqual(result.actors, { inspected: "briand-ai", approved: "briand-ai" });
  assert.deepEqual(result.receipt_assets.map((asset) => asset.name), [
    receiptAssetName("approved", STAGE_ID),
    receiptAssetName("inspected", STAGE_ID),
  ]);
});

test("split inspector and approver identities pass in both directions and both tiers", () => {
  for (const version of [PRE, STABLE]) {
    for (const [inspector, approver] of [["briand-ai", "mikec-ai"], ["mikec-ai", "briand-ai"]]) {
      const result = evaluate(version, {
        inspected: receiptFor("inspected", version, { actor: inspector }, { uploaderLogin: inspector }),
        approved: receiptFor("approved", version, { actor: approver }, { uploaderLogin: approver }),
      });
      assert.equal(result.state, "approved_public");
      assert.deepEqual(result.actors, { inspected: inspector, approved: approver });
    }
  }
});

test("TIER MATRIX — prerelease missing inspection passes WITH stamp, ledger stays staged", () => {
  const result = evaluate(PRE, { inspected: null });
  assert.equal(result.state, "staged");
  assert.deepEqual(result.missing, ["inspected"]);
  assert.deepEqual(result.verified, ["approved"]);
  assert.equal(result.stamp_required, true);
});

test("TIER MATRIX — prerelease missing both passes WITH stamp naming both", () => {
  const result = evaluate(PRE, { inspected: null, approved: null });
  assert.equal(result.state, "staged");
  assert.deepEqual(result.missing, ["inspected", "approved"]);
  assert.equal(result.stamp_required, true);
});

test("TIER MATRIX — prerelease inspected-only stamps the missing approval receipt", () => {
  const result = evaluate(PRE, { approved: null });
  assert.equal(result.state, "inspected");
  assert.deepEqual(result.missing, ["approved"]);
  assert.equal(result.stamp_required, true);
});

test("TIER MATRIX — stable with both receipts passes; missing either is red", () => {
  assert.equal(evaluate(STABLE).state, "approved_public");
  assert.throws(() => evaluate(STABLE, { inspected: null }), /missing required operator receipts: inspected/);
  assert.throws(() => evaluate(STABLE, { approved: null }), /missing required operator receipts: approved/);
  assert.throws(
    () => evaluate(STABLE, { inspected: null, approved: null }),
    /missing required operator receipts: inspected, approved/,
  );
});

test("TIER MATRIX — dry-run reports the same prerelease stamp plan while stable absence remains non-mutating", () => {
  for (const version of [PRE, STABLE]) {
    const result = evaluate(version, { mode: "dry-run", inspected: null, approved: null });
    assert.deepEqual(result.missing, ["inspected", "approved"]);
    assert.equal(result.stamp_required, version === PRE);
  }
});

test("ADVERSARIAL — present-but-invalid evidence is red in every tier and mode", () => {
  const cases = [
    ["receipt for a different stage (replayed prior candidate)", { inspected: receiptFor("inspected", PRE, { stage_id: OTHER_STAGE_ID }) }],
    ["receipt for a different draft release", { inspected: receiptFor("inspected", PRE, { draft_release_id: "999" }) }],
    ["receipt naming different bytes", { inspected: receiptFor("inspected", PRE, { tarball_sha256: OTHER_SHA, observed_sha256: OTHER_SHA }) }],
    ["actor outside the allowlist", { inspected: receiptFor("inspected", PRE, { actor: "attacker" }, { uploaderLogin: "attacker" }) }],
    ["bot-uploaded receipt (CI token cannot impersonate an operator)", { inspected: receiptFor("inspected", PRE, {}, { uploaderLogin: "github-actions[bot]" }) }],
    ["receipt uploaded after finalize dispatch", { inspected: receiptFor("inspected", PRE, {}, { uploadedAt: "2026-08-08T12:00:01Z" }) }],
    ["approval uploaded before inspection", { approved: receiptFor("approved", PRE, {}, { uploadedAt: "2026-08-08T09:00:00Z" }) }],
    ["decision/kind mismatch", { inspected: receiptFor("approved", PRE) }],
  ];
  for (const [label, receipts] of cases) {
    for (const mode of ["live", "dry-run"]) {
      assert.throws(() => evaluate(PRE, { mode, ...receipts }), /operator receipt verification failed/, `${label} (${mode})`);
    }
  }
});

test("ORDERING PRECISION — receipt pair is strict while the finalize deadline permits equality", () => {
  const sameSecond = "2026-08-08T10:31:00Z";
  for (const mode of ["live", "dry-run"]) {
    assert.throws(
      () => evaluate(STABLE, {
        mode,
        inspected: receiptFor("inspected", STABLE, {}, { uploadedAt: sameSecond }),
        approved: receiptFor("approved", STABLE, {}, { uploadedAt: sameSecond }),
      }),
      /inspection receipt upload must be strictly earlier than approval receipt upload/,
      `equal-second receipt uploads cannot prove inspection-before-approval (${mode})`,
    );
  }

  const atDispatch = evaluate(STABLE, {
    approved: receiptFor("approved", STABLE, {}, { uploadedAt: RUN_CREATED_AT }),
  });
  assert.equal(atDispatch.state, "approved_public", "receipt upload equal to finalize dispatch remains no-later-than valid");
});

test("ADVERSARIAL — a forged matching-signature receipt with a wrong observed SHA hits the state machine", () => {
  // Even if an operator signed a mismatch, the replayed inspection cross-check refuses approval.
  const version = PRE;
  const inspected = receiptFor("inspected", version);
  inspected.payload = { ...inspected.payload, observed_sha256: OTHER_SHA };
  assert.throws(
    () => evaluateOrdering({
      mode: "live",
      chain: chainFor(version),
      stageReceipt: stageReceiptFor(version),
      inspected,
      approved: null,
      runCreatedAt: RUN_CREATED_AT,
      allowedActors: ALLOWED,
    }),
    (error) => error instanceof ReleaseStateError && error.code === "inspection_mismatch",
  );
});

test("evaluateOrdering fails closed on unknown mode and empty allowlist", () => {
  assert.throws(() => evaluate(PRE, { mode: "yolo" }), /unknown mode/);
  assert.throws(
    () => evaluateOrdering({
      mode: "live",
      chain: chainFor(PRE),
      stageReceipt: stageReceiptFor(PRE),
      inspected: null,
      approved: null,
      runCreatedAt: RUN_CREATED_AT,
      allowedActors: [],
    }),
    /principal list is empty/,
  );
});

test("stamp: built only when required, names the missing evidence, annotation matches", () => {
  const result = evaluate(PRE, { inspected: null });
  const stamp = buildReceiptStatusStamp({ result, finalizeRunId: "555", emittedAt: "2026-08-08T13:00:00Z" });
  assert.equal(stamp.schema, "aslite.receipt-status.v1");
  assert.equal(stamp.note, "published without inspected receipt");
  assert.deepEqual(stamp.missing, ["inspected"]);
  assert.equal(stamp.tier, "prerelease");
  assert.equal(stamp.stage_id, STAGE_ID);
  const annotation = stampAnnotation(stamp);
  assert.match(annotation, /published without inspected receipt/);
  assert.match(annotation, new RegExp(`receipt-status-${STAGE_ID}`));
  const both = buildReceiptStatusStamp({
    result: evaluate(PRE, { inspected: null, approved: null }),
    finalizeRunId: "555",
    emittedAt: "2026-08-08T13:00:00Z",
  });
  assert.equal(both.note, "published without inspected receipt or approved receipt");
  const clean = evaluate(PRE);
  assert.throws(() => buildReceiptStatusStamp({ result: clean, finalizeRunId: "555", emittedAt: "2026-08-08T13:00:00Z" }), /does not require one/);
});

test("workflow-owned receipt-status body converges across retries and rejects malformed ownership", () => {
  const original = "Prepared draft.\n\nHuman note.\n";
  const first = normalizeReceiptStatusBody(original, "status A");
  const second = normalizeReceiptStatusBody(first, "status B");
  assert.equal((second.match(/aslite-receipt-status:start/g) ?? []).length, 1);
  assert.match(second, /status B/);
  assert.doesNotMatch(second, /status A/);
  assert.ok(second.startsWith(original), "all pre-existing release-note bytes remain untouched");
  assert.equal(verifyReceiptStatusBody(second, "status B"), true);
  const removed = normalizeReceiptStatusBody(second, null);
  assert.doesNotMatch(removed, /aslite-receipt-status/);
  assert.match(removed, /Prepared draft/);
  assert.match(removed, /Human note/);
  assert.equal(verifyReceiptStatusBody(removed, null), true);
  for (const malformed of [
    "<!-- aslite-receipt-status:start -->\nmissing end",
    "<!-- aslite-receipt-status:end -->\nmissing start",
    "<!-- aslite-receipt-status:start --><!-- aslite-receipt-status:start --><!-- aslite-receipt-status:end -->",
  ]) {
    assert.throws(() => normalizeReceiptStatusBody(malformed, "status"), /duplicate|unbalanced/);
  }
});

function releaseForPlan(version, ordering, extras = [], body = "Prepared draft.") {
  return {
    id: 300,
    draft: true,
    tag_name: `v${version}`,
    body,
    assets: [...chainFor(version).core_assets, ...ordering.receipt_assets, ...extras],
  };
}

test("publication planner emits a sorted draft-bound ID-only cleanup manifest", () => {
  const ordering = evaluate(PRE, { inspected: null });
  const status = { name: stampAssetName(STAGE_ID), digest: `sha256:${"5".repeat(64)}` };
  const release = releaseForPlan(PRE, ordering, [
    { id: 910, name: stampAssetName(STAGE_ID), digest: `sha256:${"6".repeat(64)}` },
    { id: 700, name: `receipt-inspected-${OTHER_STAGE_ID}.json`, digest: `sha256:${"7".repeat(64)}` },
    { id: 650, name: `receipt-status-${OTHER_STAGE_ID}.json`, digest: `sha256:${"8".repeat(64)}` },
  ]);
  const plan = buildPublicationPlan({ release, chain: chainFor(PRE), ordering, status, bodyAnnotation: "current annotation" });
  assert.equal(plan.draft_release_id, 300);
  assert.deepEqual(plan.delete.map(({ id, category }) => [id, category]), [
    [650, "sibling"],
    [700, "sibling"],
    [910, "current_status"],
  ]);
  assert.deepEqual(plan.keep.status, status);
  assert.ok(plan.delete.every((item) => Number.isSafeInteger(item.id)));
  const wrongDraft = { ...release, id: 301 };
  assert.throws(
    () => buildPublicationPlan({ release: wrongDraft, chain: chainFor(PRE), ordering, status, bodyAnnotation: "current annotation" }),
    /draft release id/,
  );
});

test("full receipts remove a pre-planted status asset and stale owned-body claim", () => {
  const ordering = evaluate(PRE);
  const staleBody = normalizeReceiptStatusBody("Prepared draft.", "stale missing-inspection claim");
  const release = releaseForPlan(PRE, ordering, [
    { id: 910, name: stampAssetName(STAGE_ID), digest: `sha256:${"6".repeat(64)}` },
  ], staleBody);
  const plan = buildPublicationPlan({
    release,
    chain: chainFor(PRE),
    ordering,
    status: null,
    bodyAnnotation: null,
  });
  assert.deepEqual(plan.delete, [{ id: 910, name: stampAssetName(STAGE_ID), category: "current_status" }]);
  assert.equal(plan.keep.status, null);
  const finalRelease = {
    ...release,
    body: normalizeReceiptStatusBody(staleBody, null),
    assets: [...chainFor(PRE).core_assets, ...ordering.receipt_assets],
  };
  const proof = verifyFinalPublication({ release: finalRelease, plan });
  assert.equal(proof.status_asset, null);
});

test("HIGHEST-RISK M1 — final publication binds receipt id/digest, generated status digest/final id, and exact set", () => {
  const ordering = evaluate(PRE, { inspected: null });
  const status = { name: stampAssetName(STAGE_ID), digest: `sha256:${"5".repeat(64)}` };
  const annotation = "current annotation";
  const plan = buildPublicationPlan({
    release: releaseForPlan(PRE, ordering),
    chain: chainFor(PRE),
    ordering,
    status,
    bodyAnnotation: annotation,
  });
  const approval = ordering.receipt_assets[0];
  const body = normalizeReceiptStatusBody("Prepared draft.", annotation);
  const replaced = releaseForPlan(PRE, ordering, [], body);
  replaced.assets = [
    ...chainFor(PRE).core_assets,
    { ...approval, id: 777, digest: `sha256:${"b".repeat(64)}` },
    { id: 888, name: status.name, digest: `sha256:${"f".repeat(64)}` },
  ];
  assert.throws(() => verifyFinalPublication({ release: replaced, plan }), /differs from verified id\/name\/digest/);

  const restoredApproval = { ...replaced, assets: [...chainFor(PRE).core_assets, approval, replaced.assets.at(-1)] };
  assert.throws(() => verifyFinalPublication({ release: restoredApproval, plan }), /differs from generated bytes/);

  const exact = {
    ...restoredApproval,
    assets: [...chainFor(PRE).core_assets, approval, { id: 999, name: status.name, digest: status.digest }],
  };
  const proof = verifyFinalPublication({ release: exact, plan });
  assert.deepEqual(proof.status_asset, { id: 999, name: status.name, digest: status.digest });

  const sibling = {
    ...exact,
    assets: [...exact.assets, { id: 1000, name: `receipt-status-${OTHER_STAGE_ID}.json`, digest: `sha256:${"e".repeat(64)}` }],
  };
  assert.throws(() => verifyFinalPublication({ release: sibling, plan }), /unexpected final asset/);
});

test("publication executor is empirically mutation-free in dry-run and live uses exact IDs plus --clobber", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "aslite-publication-apply-"));
  try {
    const statusBytes = Buffer.from("generated status bytes\n");
    const status = { name: stampAssetName(STAGE_ID), digest: sha256Bytes(statusBytes) };
    const ordering = evaluate(PRE, { inspected: null });
    const plan = buildPublicationPlan({
      release: releaseForPlan(PRE, ordering, [
        { id: 910, name: stampAssetName(STAGE_ID), digest: `sha256:${"6".repeat(64)}` },
        { id: 700, name: `receipt-inspected-${OTHER_STAGE_ID}.json`, digest: `sha256:${"7".repeat(64)}` },
      ]),
      chain: chainFor(PRE),
      ordering,
      status,
      bodyAnnotation: "current annotation",
    });
    writeFileSync(path.join(scratch, status.name), statusBytes);
    writeFileSync(path.join(scratch, "body.txt"), normalizeReceiptStatusBody("Prepared draft.", "current annotation"));
    const calls = [];
    let injectedAbsent = false;
    const runner = (command, args) => {
      calls.push([command, ...args]);
      if (!injectedAbsent && args.includes("repos/Holaxis-ai/agentstate-lite/releases/assets/700")) {
        injectedAbsent = true;
        const error = new Error("HTTP 404");
        error.stderr = "Not Found";
        throw error;
      }
    };
    const dry = await applyPublicationPlan({ mode: "dry-run", plan, repo: "Holaxis-ai/agentstate-lite", outDir: scratch, run: runner });
    assert.deepEqual(dry, { mutated: false, calls: 0 });
    assert.deepEqual(calls, [], "dry-run invokes no cleanup, upload, or PATCH command");
    const bin = path.join(scratch, "bin");
    const publishLog = path.join(scratch, "publish.log");
    mkdirSync(bin);
    const ghStub = path.join(bin, "gh");
    writeFileSync(ghStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ASLITE_TEST_PUBLISH_LOG"\n`);
    chmodSync(ghStub, 0o755);
    const dryPublish = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "release-run-operations.mjs"),
      "--op", "immutable-release", "--version", PRE, "--release-id", "300",
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASLITE_TEST_PUBLISH_LOG: publishLog },
    });
    assert.equal(dryPublish.status, 0);
    assert.equal(existsSync(publishLog), false, "dry-run renders publication but never invokes gh");

    await applyPublicationPlan({ mode: "live", plan, repo: "Holaxis-ai/agentstate-lite", outDir: scratch, run: runner });
    const deletes = calls.filter((call) => call.includes("DELETE"));
    assert.deepEqual(deletes.map((call) => call.find((token) => token.includes("releases/assets/"))), [
      "repos/Holaxis-ai/agentstate-lite/releases/assets/700",
      "repos/Holaxis-ai/agentstate-lite/releases/assets/910",
    ]);
    assert.equal(injectedAbsent, true, "an already-absent planned ID is retry-tolerated");
    const upload = calls.find((call) => call[1] === "release" && call[2] === "upload");
    assert.ok(upload.includes("--clobber"));
    assert.ok(calls.some((call) => call.includes("PATCH") && call.some((token) => token === "repos/Holaxis-ai/agentstate-lite/releases/300")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("receipt emission commands are validated and injection-shaped values throw", () => {
  const commands = receiptEmissionCommands({ stageId: STAGE_ID, version: PRE, draftReleaseId: "300" });
  assert.match(commands.inspected, /release-inspect\.mjs --stage-id/);
  assert.match(commands.approved, /--decision approved$/);
  assert.throws(() => receiptEmissionCommands({ stageId: "-rf; rm", version: PRE, draftReleaseId: "300" }), /invalid stage id/);
});

test("selectReceiptAssets picks THIS stage's receipts, ignores siblings, rejects duplicates", () => {
  const release = {
    assets: [
      { id: 1, name: `receipt-inspected-${STAGE_ID}.json`, uploader: { login: "briand-ai" }, created_at: "2026-08-08T10:01:00Z" },
      { id: 2, name: `receipt-approved-${STAGE_ID}.json`, uploader: { login: "briand-ai" }, created_at: "2026-08-08T10:31:00Z" },
      { id: 3, name: `receipt-inspected-${OTHER_STAGE_ID}.json`, uploader: { login: "briand-ai" }, created_at: "2026-08-08T09:00:00Z" },
      { id: 4, name: "holaxis-aslite-0.1.0-pre.4.tgz" },
      { id: 5, name: "candidate.json" },
    ],
  };
  const found = selectReceiptAssets(release, STAGE_ID);
  assert.deepEqual(Object.keys(found).sort(), ["approved", "inspected"]);
  assert.equal(found.inspected.id, "1");
  assert.equal(found.approved.uploaderLogin, "briand-ai");
  release.assets.push({ id: 6, name: `receipt-inspected-${STAGE_ID}.json` });
  assert.throws(() => selectReceiptAssets(release, STAGE_ID), /duplicate inspected receipt asset/);
});

test("the committed allowed-signers file names exactly the ratified operators", () => {
  const text = readFileSync(path.join(repoRoot, ".github", "release-allowed-signers"), "utf8");
  assert.deepEqual(allowedSignerPrincipals(text).sort(), ["briand-ai", "mikec-ai"]);
  assert.match(text, new RegExp(`namespaces="${SIGN_NAMESPACE}"`), "keys are scoped to the receipt namespace");
});

// --- real ssh-keygen signature round-trips (throwaway key) ---

function withScratch(fn) {
  const scratch = mkdtempSync(path.join(tmpdir(), "aslite-ordering-test-"));
  try {
    return fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function makeSigner(scratch, principal) {
  const keyPath = path.join(scratch, `${principal}-key`);
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", principal, "-f", keyPath]);
  const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  return { keyPath, allowedLine: `${principal} namespaces="${SIGN_NAMESPACE}" ${publicKey}` };
}

function signReceipt(scratch, keyPath, payload, namespace = SIGN_NAMESPACE) {
  const messagePath = path.join(scratch, `payload-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(messagePath, canonicalPayloadBytes(payload));
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, messagePath], { stdio: "pipe" });
  return JSON.stringify({ payload, signature: readFileSync(`${messagePath}.sig`, "utf8") });
}

test("ssh signature round-trip: signed receipt verifies; tampering/wrong key/namespace/principal are red", () => {
  withScratch((scratch) => {
    const brian = makeSigner(scratch, "briand-ai");
    const outsider = makeSigner(scratch, "outsider");
    const signersPath = path.join(scratch, "allowed_signers");
    writeFileSync(signersPath, `${brian.allowedLine}\n`);

    const payload = receiptFor("inspected", PRE).payload;
    const good = signReceipt(scratch, brian.keyPath, payload);
    assert.deepEqual(verifySignedReceipt({ text: good, allowedSignersPath: signersPath }), payload);

    // Tampered payload after signing.
    const parsed = JSON.parse(good);
    parsed.payload = { ...parsed.payload, tarball_sha256: OTHER_SHA, observed_sha256: OTHER_SHA };
    assert.throws(
      () => verifySignedReceipt({ text: JSON.stringify(parsed), allowedSignersPath: signersPath }),
      /ssh signature check failed/,
    );

    // Signed by a key outside allowed_signers (even claiming an allowed actor).
    const forged = signReceipt(scratch, outsider.keyPath, payload);
    assert.throws(() => verifySignedReceipt({ text: forged, allowedSignersPath: signersPath }), /ssh signature check failed/);

    // Signed in the wrong namespace.
    const wrongNs = signReceipt(scratch, brian.keyPath, payload, "file");
    assert.throws(() => verifySignedReceipt({ text: wrongNs, allowedSignersPath: signersPath }), /ssh signature check failed/);

    // Payload actor is not the signing principal.
    const otherActor = { ...payload, actor: "mikec-ai" };
    const wrongPrincipal = signReceipt(scratch, brian.keyPath, otherActor);
    assert.throws(() => verifySignedReceipt({ text: wrongPrincipal, allowedSignersPath: signersPath }), /ssh signature check failed/);

    // Not a signature at all.
    assert.throws(
      () => parseReceiptFile(JSON.stringify({ payload, signature: "hello" })),
      /not an SSH signature block/,
    );
  });
});

test("verify/plan/final subcommands bind downloaded bytes through the final publication proof", async () => {
  await (async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "aslite-ordering-e2e-"));
    try {
      const brian = makeSigner(scratch, "briand-ai");
      const signersPath = path.join(scratch, "allowed_signers");
      writeFileSync(signersPath, `${brian.allowedLine}\n`);

      const inspected = receiptFor("inspected", PRE).payload;
      const approved = receiptFor("approved", PRE, { actor: "mikec-ai" }).payload;
      const mike = makeSigner(scratch, "mikec-ai");
      writeFileSync(signersPath, `${brian.allowedLine}\n${mike.allowedLine}\n`);
      const receiptsDir = path.join(scratch, "receipts");
      mkdirSync(receiptsDir, { recursive: true });
      const inspectedText = signReceipt(scratch, brian.keyPath, inspected);
      const approvedText = signReceipt(scratch, mike.keyPath, approved);
      writeFileSync(path.join(receiptsDir, receiptAssetName("inspected", STAGE_ID)), inspectedText);
      writeFileSync(path.join(receiptsDir, receiptAssetName("approved", STAGE_ID)), approvedText);

      const release = {
        id: 300,
        draft: true,
        tag_name: `v${PRE}`,
        body: "Prepared draft.",
        assets: [
          ...chainFor(PRE).core_assets,
          { id: 401, name: receiptAssetName("inspected", STAGE_ID), digest: sha256Bytes(inspectedText), uploader: { login: "briand-ai" }, created_at: "2026-08-08T10:01:00Z" },
          { id: 402, name: receiptAssetName("approved", STAGE_ID), digest: sha256Bytes(approvedText), uploader: { login: "mikec-ai" }, created_at: "2026-08-08T10:31:00Z" },
        ],
      };
      const releasePath = path.join(scratch, "draft-release.json");
      const chainPath = path.join(scratch, "verified-chain.json");
      const stagePath = path.join(scratch, "stage-receipt.json");
      const outPath = path.join(scratch, "ordering-result.json");
      writeFileSync(releasePath, JSON.stringify(release));
      writeFileSync(chainPath, JSON.stringify(chainFor(PRE)));
      writeFileSync(stagePath, JSON.stringify(stageReceiptFor(PRE)));

      const digestMismatch = {
        ...release,
        assets: release.assets.map((asset) => asset.name === receiptAssetName("inspected", STAGE_ID)
          ? { ...asset, digest: `sha256:${"f".repeat(64)}` }
          : asset),
      };
      writeFileSync(releasePath, JSON.stringify(digestMismatch));
      await assert.rejects(
        verifyOrderingMain([
          "verify", "--mode", "live", "--chain", chainPath, "--receipt", stagePath,
          "--release", releasePath, "--receipts-dir", receiptsDir, "--run-created-at", RUN_CREATED_AT,
          "--allowed-signers", signersPath, "--out", outPath,
        ]),
        /downloaded digest .* != GitHub asset digest/,
      );
      writeFileSync(releasePath, JSON.stringify(release));

      await verifyOrderingMain([
        "verify",
        "--mode", "live",
        "--chain", chainPath,
        "--receipt", stagePath,
        "--release", releasePath,
        "--receipts-dir", receiptsDir,
        "--run-created-at", RUN_CREATED_AT,
        "--allowed-signers", signersPath,
        "--out", outPath,
      ]);
      const result = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(result.state, "approved_public");
      assert.equal(result.stamp_required, false);
      assert.deepEqual(result.actors, { inspected: "briand-ai", approved: "mikec-ai" });

      // A stamped path: strip the inspection receipt and re-verify, then generate the complete plan.
      const bare = { ...release, assets: release.assets.filter((asset) => asset.name !== receiptAssetName("inspected", STAGE_ID)) };
      writeFileSync(releasePath, JSON.stringify(bare));
      await verifyOrderingMain([
        "verify",
        "--mode", "live",
        "--chain", chainPath,
        "--receipt", stagePath,
        "--release", releasePath,
        "--receipts-dir", receiptsDir,
        "--run-created-at", RUN_CREATED_AT,
        "--allowed-signers", signersPath,
        "--out", outPath,
      ]);
      const stampedResult = JSON.parse(readFileSync(outPath, "utf8"));
      assert.deepEqual(stampedResult.missing, ["inspected"]);
      assert.equal(stampedResult.stamp_required, true);

      const stampDir = path.join(scratch, "publication-out");
      const planPath = path.join(scratch, "publication-plan.json");
      await verifyOrderingMain([
        "plan",
        "--result", outPath,
        "--chain", chainPath,
        "--release", releasePath,
        "--out-dir", stampDir,
        "--finalize-run-id", "555",
        "--out", planPath,
      ]);
      const assetName = readFileSync(path.join(stampDir, "asset-name.txt"), "utf8").trim();
      assert.equal(assetName, stampAssetName(STAGE_ID));
      const stamp = JSON.parse(readFileSync(path.join(stampDir, assetName), "utf8"));
      assert.equal(stamp.note, "published without inspected receipt");
      const body = readFileSync(path.join(stampDir, "body.txt"), "utf8");
      assert.ok(body.startsWith("Prepared draft.\n\n"), "existing release body is preserved");
      assert.match(body, /published without inspected receipt/);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      assert.equal(plan.keep.status.digest, sha256Bytes(readFileSync(path.join(stampDir, assetName))));

      const finalRelease = {
        ...bare,
        body,
        assets: [
          ...chainFor(PRE).core_assets,
          ...stampedResult.receipt_assets,
          { id: 999, name: assetName, digest: plan.keep.status.digest },
        ],
      };
      const finalReleasePath = path.join(scratch, "final-release.json");
      const finalProofPath = path.join(scratch, "final-proof.json");
      writeFileSync(finalReleasePath, JSON.stringify(finalRelease));
      await verifyOrderingMain(["final", "--release", finalReleasePath, "--plan", planPath, "--out", finalProofPath]);
      assert.equal(JSON.parse(readFileSync(finalProofPath, "utf8")).status_asset.id, 999);

      // No stamp required -> empty asset-name.txt sentinel.
      writeFileSync(outPath, JSON.stringify(result));
      writeFileSync(releasePath, JSON.stringify(release));
      const cleanDir = path.join(scratch, "publication-clean");
      await verifyOrderingMain([
        "plan", "--result", outPath, "--chain", chainPath, "--release", releasePath,
        "--out-dir", cleanDir, "--finalize-run-id", "555", "--out", path.join(scratch, "clean-plan.json"),
      ]);
      assert.equal(readFileSync(path.join(cleanDir, "asset-name.txt"), "utf8"), "");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
});

test("inspection refuses a draft/tag mismatch before download, signing, or upload", () => {
  const harness = mkdtempSync(path.join(tmpdir(), "aslite-inspect-tag-mismatch-test-"));
  try {
    const bin = path.join(harness, "bin");
    const controlledTmp = path.join(harness, "tmp");
    mkdirSync(bin);
    mkdirSync(controlledTmp);
    const ghLog = path.join(harness, "gh.log");
    const operationsLog = path.join(harness, "operations.log");
    const recoveryDir = path.join(harness, "recovery");
    const ghStub = path.join(bin, "gh");
    writeFileSync(ghStub, `#!/bin/sh
printf '%s\\n' "$*" >> "$ASLITE_TEST_GH_LOG"
case "$*" in
  *releases/300*) printf '%s\\n' '{"id":300,"draft":true,"tag_name":"v9.9.9","assets":[]}' ;;
  *) exit 2 ;;
esac
`);
    for (const command of ["npm", "ssh-keygen"]) {
      const stub = path.join(bin, command);
      writeFileSync(stub, `#!/bin/sh
printf '%s %s\\n' '${command}' "$*" >> "$ASLITE_TEST_OPERATIONS_LOG"
exit 99
`);
      chmodSync(stub, 0o755);
    }
    chmodSync(ghStub, 0o755);
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "release-inspect.mjs"),
      "--stage-id", STAGE_ID,
      "--version", PRE,
      "--draft-release-id", "300",
      "--key", path.join(harness, "unused-key"),
      "--repo", "Holaxis-ai/agentstate-lite",
      "--recovery-dir", recoveryDir,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: controlledTmp,
        ASLITE_TEST_GH_LOG: ghLog,
        ASLITE_TEST_OPERATIONS_LOG: operationsLog,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /draft release tag v9\.9\.9 does not match expected v0\.1\.0-pre\.4/);
    assert.doesNotMatch(readFileSync(ghLog, "utf8"), /release upload/, "tag mismatch never uploads a receipt");
    assert.equal(existsSync(operationsLog), false, "tag mismatch never invokes npm download or ssh signing");
    assert.deepEqual(readdirSync(controlledTmp), [], "tag mismatch unwinds scratch state");
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
});

test("inspection mismatch unwinds batch scratch state, emits no receipt, and prints reject guidance", () => {
  const harness = mkdtempSync(path.join(tmpdir(), "aslite-inspect-mismatch-test-"));
  try {
    const bin = path.join(harness, "bin");
    const controlledTmp = path.join(harness, "tmp");
    mkdirSync(bin);
    mkdirSync(controlledTmp);
    const manifestPath = path.join(harness, "candidate.json");
    const batchPath = path.join(harness, "batch.json");
    const ghLog = path.join(harness, "gh.log");
    const recoveryDir = path.join(harness, "recovery");
    const manifestText = JSON.stringify({
      schema: "aslite.release-candidate.v1",
      tag: `v${PRE}`,
      version: PRE,
      tarball: { version: PRE, sha256: TARBALL_SHA, integrity: INTEGRITY },
    });
    writeFileSync(manifestPath, manifestText);
    const manifestDigest = sha256Bytes(manifestText);
    writeFileSync(batchPath, JSON.stringify([{
      stage_id: STAGE_ID,
      version: PRE,
      draft_release_id: "300",
      decision: "inspected",
    }]));
    const ghStub = path.join(bin, "gh");
    writeFileSync(ghStub, `#!/bin/sh
printf '%s\\n' "$*" >> "$ASLITE_TEST_GH_LOG"
case "$*" in
  *releases/assets/*) exec /bin/cat "$ASLITE_TEST_MANIFEST" ;;
  *--paginate*releases/300/assets*) printf '%s\\n' '[[{"id":22,"name":"candidate.json","digest":"${manifestDigest}"}]]' ;;
  *releases/300*) printf '%s\\n' '{"id":300,"draft":true,"tag_name":"v0.1.0-pre.4","upload_url":"https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets{?name,label}"}' ;;
  'api user --jq .login') printf '%s\\n' 'briand-ai' ;;
  *) exit 2 ;;
esac
`);
    const npmStub = path.join(bin, "npm");
    writeFileSync(npmStub, `#!/bin/sh
if [ "$1:$2:$3" = "stage:download:${STAGE_ID}" ]; then
  printf '%s' 'mismatching staged bytes' > "$ASLITE_TEST_DOWNLOAD_NAME"
  exit 0
fi
exit 2
`);
    chmodSync(ghStub, 0o755);
    chmodSync(npmStub, 0o755);
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "release-inspect.mjs"),
      "--batch", batchPath,
      "--key", path.join(harness, "unused-key"),
      "--repo", "Holaxis-ai/agentstate-lite",
      "--recovery-dir", recoveryDir,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: controlledTmp,
        ASLITE_TEST_GH_LOG: ghLog,
        ASLITE_TEST_MANIFEST: manifestPath,
        ASLITE_TEST_DOWNLOAD_NAME: `holaxis-aslite-${PRE}-${STAGE_ID}.tgz`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISMATCH: staged tarball/);
    assert.match(result.stderr, new RegExp(`npm stage reject ${STAGE_ID}`));
    assert.match(result.stderr, /receipt not emitted/);
    assert.deepEqual(readdirSync(controlledTmp), [], "finally removes the scratch directory and suspect tarball");
    assert.deepEqual(readdirSync(recoveryDir), [], "failed inspection releases its owner and writes no journal");
    assert.doesNotMatch(readFileSync(ghLog, "utf8"), /release upload/, "mismatch never uploads a receipt");
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
});
