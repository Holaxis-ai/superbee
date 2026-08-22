import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildStageReceipt,
  parseStagePublishJson,
  stageDownloadFilenameFor,
  verifyArtifactMetadata,
  verifyFinalizerChain,
} from "./release-receipts.mjs";
import * as allReceipts from "./release-receipts.mjs";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../packages/cli/src/integration-guidance.js";
import { buildReceipt, renderReceiptMarkdown } from "./release-emit-receipt.mjs";
import { defaultReleaseManifest, defaultReleaseTargets } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const emitReceipt = path.join(repoRoot, "scripts", "release-emit-receipt.mjs");

const STAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const VERSION = "0.1.0-pre.4";
const COMMIT = "1".repeat(40);
const TARBALL_SHA = "sha256:" + "a".repeat(64);
const MANIFEST_SHA = "sha256:" + "b".repeat(64);
const CANDIDATE_ARTIFACT_DIGEST = "sha256:" + "c".repeat(64);
const RECEIPT_ARTIFACT_DIGEST = "sha256:" + "d".repeat(64);
const INTEGRITY = "sha512-YWJjZA==";
const TARBALL = `holaxis-aslite-${VERSION}.tgz`;

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
  assert.equal(stageDownloadFilenameFor("bridge", VERSION, STAGE_ID), `holaxis-aslite-${VERSION}-${STAGE_ID}.tgz`);
  assert.equal(stageDownloadFilenameFor("successor-stable", "0.1.0", STAGE_ID), `superbee-0.1.0-${STAGE_ID}.tgz`);
  // The bridge-hardcoded stageDownloadFilename(version, stageId) helper is gone: naming the
  // downloaded tarball requires saying which package was staged.
  for (const missing of [undefined, null, "", "shadow"]) {
    assert.throws(
      () => stageDownloadFilenameFor(missing, VERSION, STAGE_ID),
      /release receipt verification failed/,
      `must reject target ${JSON.stringify(missing)}`,
    );
  }
});

test("declared rehearsal targets resolve from the manifest but cannot enter the full stage receipt chain", () => {
  assert.throws(
    () => buildStageReceipt({ target: "rehearsal-reject", version: "0.0.0-rename-reject.20260812", stageId: STAGE_ID }),
    /requires workflow contract full/,
  );
});

test("stage receipts reject ambiguous package-only lookup instead of redirecting to bridge", () => {
  assert.throws(
    () =>
      buildStageReceipt({
        packageName: "superbee",
        runId: "100",
        artifactId: "101",
        artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
        stageId: STAGE_ID,
        version: "0.1.1-pre.1",
        tag: "v0.1.1-pre.1",
        sourceCommit: COMMIT,
        policyTag: "next",
        tarballSha256: TARBALL_SHA,
        tarballFilename: "superbee-0.1.1-pre.1.tgz",
        integrity: INTEGRITY,
        manifestSha256: MANIFEST_SHA,
        draftReleaseId: "300",
        draftAssets: [
          { id: "201", name: "superbee-0.1.1-pre.1.tgz", digest: TARBALL_SHA },
          { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
        ],
      }),
    /ambiguous across targets successor-preview, successor-stable; explicit target required/,
  );
});

function fixture({ version = VERSION } = {}) {
  const tarball = `holaxis-aslite-${version}.tgz`;
  const draftAssets = [
    { id: "201", name: tarball, digest: TARBALL_SHA },
    { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
  ];
  const receipt = buildStageReceipt({
    target: "bridge",
    runId: "100",
    artifactId: "101",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    version,
    tag: `v${version}`,
    sourceCommit: COMMIT,
    policyTag: "next",
    tarballSha256: TARBALL_SHA,
    tarballFilename: tarball,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets,
  });
  const candidate = {
    schema: "superbee.release-candidate.v1",
    target: "bridge",
    package: { name: "@holaxis/aslite" },
    tag: `v${version}`,
    version,
    source: { commit: COMMIT, dirty: false },
    tarball: { filename: tarball, sha256: TARBALL_SHA, integrity: INTEGRITY },
  };
  const dispatch = {
    runId: "100",
    artifactId: "101",
    stageReceiptArtifactId: "102",
    stageReceiptArtifactDigest: RECEIPT_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    draftReleaseId: "300",
    version,
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
    release: { id: 300, draft: true, tag_name: `v${version}`, assets: draftAssets },
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

test("pre-PATCH finalizer binding accepts the expected durable tag or GitHub's temporary draft form", () => {
  const stable = fixture({ version: "0.1.0" });
  assert.doesNotThrow(() => verifyFinalizerChain({ ...stable, draftTagPhase: "pre-patch" }));

  const temporary = fixture();
  temporary.release.tag_name = "untagged-a825eda34d7bf2a2598c";
  assert.doesNotThrow(() => verifyFinalizerChain({ ...temporary, draftTagPhase: "pre-patch" }));

  for (const tag of [
    "v0.1.0",
    "durable-release",
    "untagged-A825EDA34D7BF2A2598C",
    "untagged-a825eda34d7bf2a2598",
    "other-a825eda34d7bf2a2598c",
    undefined,
  ]) {
    const mismatched = fixture();
    mismatched.release.tag_name = tag;
    assert.throws(
      () => verifyFinalizerChain({ ...mismatched, draftTagPhase: "pre-patch" }),
      /release receipt verification failed/,
      tag,
    );
  }

  const postPatch = fixture({ version: "0.1.0" });
  postPatch.release.tag_name = "untagged-a825eda34d7bf2a2598c";
  assert.throws(
    () => verifyFinalizerChain({ ...postPatch, draftTagPhase: "declared" }),
    /release receipt verification failed/,
  );
  assert.throws(
    () => verifyFinalizerChain({ ...fixture(), draftTagPhase: "unknown" }),
    /invalid draft tag phase/,
  );
});

test("artifact metadata primitive binds exact id, digest, run, head, name, and expiry", () => {
  const metadata = {
    id: 700,
    name: "release-finalization-proof",
    digest: `sha256:${"7".repeat(64)}`,
    expired: false,
    workflow_run: { id: 800, head_sha: COMMIT },
  };
  const expected = {
    id: "700",
    name: "release-finalization-proof",
    digest: "7".repeat(64),
    runId: "800",
    commit: COMMIT,
  };
  assert.doesNotThrow(() => verifyArtifactMetadata("proof", metadata, expected));
  for (const mutate of [
    (value) => { value.id = 701; },
    (value) => { value.name = "other"; },
    (value) => { value.digest = `sha256:${"8".repeat(64)}`; },
    (value) => { value.workflow_run.id = 801; },
    (value) => { value.workflow_run.head_sha = "2".repeat(40); },
    (value) => { value.expired = true; },
  ]) {
    const changed = structuredClone(metadata);
    mutate(changed);
    assert.throws(() => verifyArtifactMetadata("proof", changed, expected), /release receipt verification failed/);
  }
});

test("stage summary and retained JSON are emitted from the same v2 receipt", () => {
  const f = fixture();
  const built = buildReceipt({
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
    draftAssets: f.release.assets,
  });
  const summary = renderReceiptMarkdown(built);
  assert.equal((summary.match(/## Stable MCP launch/g) ?? []).length, 1);
  assert.match(summary, /npm install -g superbee/);
  assert.match(summary, /superbee mcp install --host <id>/);
  assert.match(summary, /never an npx cache or one bundle directory/);
  assert.match(summary, /superbee mcp status --host <id>/);
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
    target: "bridge",
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
        target: "bridge",
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
    target: "bridge",
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

// ── F7: the receipt's promote operation is the manifest's npm_promote_tag, never the stage tag ──
// The finalize workflow promotes to `publication.npm_promote_tag`; the receipt is what a human
// follows when that workflow fails. Building it from the stage tag (`publication.npm_tag`) told the
// operator to re-apply the tag the package already holds while the workflow moved a different one.
function receiptFieldsFor(target, version, tarballBasename, policyTag = "next") {
  const tarball = `${tarballBasename}-${version}.tgz`;
  return {
    target,
    runId: "100",
    artifactId: "101",
    artifactDigest: CANDIDATE_ARTIFACT_DIGEST,
    stageId: STAGE_ID,
    version,
    tag: `v${version}`,
    sourceCommit: COMMIT,
    policyTag,
    tarballSha256: TARBALL_SHA,
    tarballFilename: tarball,
    integrity: INTEGRITY,
    manifestSha256: MANIFEST_SHA,
    draftReleaseId: "300",
    draftAssets: [
      { id: "201", name: tarball, digest: TARBALL_SHA },
      { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
    ],
  };
}

test("the receipt promotes to the tuple's npm_promote_tag, not the stage tag the package holds", () => {
  const built = buildReceipt(receiptFieldsFor("successor-stable", "0.1.0", "superbee"));
  assert.equal(built.receipt.stage.tag, "next", "the stage tag is what npm published");
  assert.equal(built.operations.promote.command, "npm dist-tag add superbee@0.1.0 latest");
  assert.equal(built.operations.promote.requires_2fa, true);
  assert.match(renderReceiptMarkdown(built), /npm dist-tag add superbee@0\.1\.0 latest/);
});

// Promotion has no automated credential (npm trusted publishing is publish-scoped), so this receipt
// is the operator's ONLY instruction for it and must say on its face that nothing else will do it.
test("the receipt presents promotion as a required operator action no workflow performs", () => {
  const markdown = renderReceiptMarkdown(buildReceipt(receiptFieldsFor("successor-stable", "0.1.0", "superbee")));
  assert.match(markdown, /REQUIRED operator action/);
  assert.match(markdown, /no workflow performs this/);
  assert.match(markdown, /requires 2FA/);
  assert.ok(
    markdown.indexOf("npm dist-tag add superbee@0.1.0 latest") > markdown.indexOf("REQUIRED operator action"),
    "the command belongs under the operator-action heading",
  );
});

test("the receipt omits promote entirely when the tuple declares npm_promote_tag: null", () => {
  // The bridge now declares `latest`, so successor-preview is the remaining publishing tuple that
  // promotes to nothing. The sibling test asserts the derived value for EVERY target.
  for (const [target, version, basename] of [
    ["successor-preview", "0.1.1-pre.1", "superbee"],
  ]) {
    const built = buildReceipt(receiptFieldsFor(target, version, basename));
    // Absent, not empty and not a no-op command: the key does not exist at all.
    assert.ok(!Object.hasOwn(built.operations, "promote"), `${target} must emit no promote operation`);
    assert.ok(!JSON.stringify(built.operations).includes("dist-tag"), `${target} operations must carry no dist-tag command`);
    const markdown = renderReceiptMarkdown(built);
    assert.ok(!/npm dist-tag/.test(markdown), `${target} receipt must not tell the operator to move a dist-tag`);
    assert.match(markdown, /declares no dist-tag promotion/);
    assert.match(markdown, /No workflow promotes it and neither should you/);
  }
});

// The class, not the probe: EVERY target declared in the manifest — including any added later.
// A full-contract target's promotion comes from its own tuple; an identity-only rehearsal target
// cannot produce a stage receipt at all, so it can never emit a promote command either.
test("every declared target's receipt promotion equals its manifest tuple's npm_promote_tag", () => {
  const manifest = defaultReleaseManifest();
  const promotions = {};
  for (const [id, target] of Object.entries(manifest.targets)) {
    const tuple = manifest.allowed_tuples[id];
    const fields = receiptFieldsFor(id, tuple.version, target.tarball_basename, tuple.publication.npm_tag ?? "next");
    if (target.workflow_contract !== "full") {
      assert.throws(() => buildReceipt(fields), /requires workflow contract full/, `${id} must not reach the receipt chain`);
      promotions[id] = null;
      continue;
    }
    const built = buildReceipt(fields);
    const promoted = built.operations.promote ? built.operations.promote.argv.at(-1) : null;
    assert.equal(promoted, tuple.publication.npm_promote_tag, `receipt promotion for ${id}`);
    if (built.operations.promote) {
      assert.equal(built.operations.promote.argv.at(-2), `${target.package.name}@${tuple.version}`);
    }
    promotions[id] = promoted;
  }
  assert.deepEqual(promotions, {
    bridge: "latest",
    "successor-stable": "latest",
    "successor-preview": null,
    "rehearsal-approve": null,
    "rehearsal-reject": null,
  });
});

// ── F8: no silent bridge redirect. The target decides which package the receipt names. ──
// Enumerated from the module, not from a list of known offenders: any helper that can produce a
// package-bound name without being told the target fails here.
test("no exported receipt helper names a package tarball without an explicit target", () => {
  const basenames = [...new Set(Object.values(defaultReleaseTargets()).map((target) => target.tarball_basename))];
  for (const [name, exported] of Object.entries(allReceipts)) {
    if (typeof exported !== "function") continue;
    for (const args of [[VERSION, STAGE_ID], [{ version: VERSION, stageId: STAGE_ID }], [undefined, VERSION, STAGE_ID]]) {
      let produced;
      try {
        produced = exported(...args);
      } catch {
        continue; // already fails closed
      }
      const rendered = JSON.stringify(produced ?? null);
      for (const basename of basenames) {
        assert.ok(!rendered.includes(basename), `${name} named ${basename} without an explicit target: ${rendered}`);
      }
    }
  }
});

test("buildReceipt refuses to invent a target instead of emitting a bridge-shaped receipt", () => {
  const { target, ...withoutTarget } = receiptFieldsFor("bridge", VERSION, "holaxis-aslite");
  assert.equal(target, "bridge");
  assert.throws(() => buildReceipt(withoutTarget), /requires an explicit target/);
  // An unambiguous package name still resolves through the receipt's own resolver; `superbee` is
  // ambiguous across the two successor targets and stays refused rather than defaulted.
  assert.equal(buildReceipt({ ...withoutTarget, packageName: "@holaxis/aslite" }).receipt.prepared.target, "bridge");
  assert.throws(
    () => buildReceipt({ ...receiptFieldsFor("successor-stable", "0.1.0", "superbee"), target: undefined, packageName: "superbee" }),
    /ambiguous across targets successor-preview, successor-stable/,
  );
});

function emitReceiptArgs(extra) {
  const tarball = `holaxis-aslite-${VERSION}.tgz`;
  return [
    emitReceipt,
    "--run-id", "100",
    "--artifact-id", "101",
    "--artifact-digest", CANDIDATE_ARTIFACT_DIGEST,
    "--stage-id", STAGE_ID,
    "--version", VERSION,
    "--tag", `v${VERSION}`,
    "--source-commit", COMMIT,
    "--policy-tag", "next",
    "--tarball-sha256", TARBALL_SHA,
    "--tarball-filename", tarball,
    "--integrity", INTEGRITY,
    "--manifest-sha256", MANIFEST_SHA,
    "--draft-release-id", "300",
    "--draft-assets-json", JSON.stringify([
      { id: "201", name: tarball, digest: TARBALL_SHA },
      { id: "202", name: "candidate.json", digest: MANIFEST_SHA },
    ]),
    ...extra,
  ];
}

test("release-emit-receipt.mjs without --target exits non-zero and prints no bridge receipt", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, emitReceiptArgs([])),
    (error) => {
      assert.match(String(error.stderr ?? error.message), /missing --target/);
      assert.ok(!String(error.stdout ?? "").includes("@holaxis/aslite"), "no bridge-shaped receipt may reach stdout");
      return true;
    },
  );
  const { stdout } = await execFileAsync(process.execPath, emitReceiptArgs(["--target", "bridge"]));
  assert.match(stdout, /holaxis-aslite/);
});

test("a live receipt still refuses a non-UUID, non-sentinel stage id", () => {
  assert.throws(
    () => buildReceipt({
      target: "bridge",
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
