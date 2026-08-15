// Pure parsers and validators for the immutable staged-release receipt chain. Workflows pass
// untrusted API/input JSON into these functions; every identifier and digest is checked before it
// can authorize registry or GitHub mutation.
import { DRY_RUN_STAGE_ID, LIVE_STAGE_ID, parseAuxiliaryReleaseAssetName } from "./release-ordering.mjs";
import {
  assertWorkflowContract,
  defaultReleaseTargets,
  RELEASE_CANDIDATE_SCHEMA,
  RELEASE_FINALIZER_PROOF_SCHEMA,
  RELEASE_STAGE_RECEIPT_SCHEMA,
  resolveDeclaredTarget,
  stageDownloadFilenameForTarget,
  tarballFilename as releaseTarballFilename,
} from "./release-targets.mjs";
import { isStrictSemver } from "./strict-semver.mjs";

const TOKEN = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BARE_SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`release receipt verification failed: ${message}`);
}

function string(name, value, pattern = TOKEN) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !pattern.test(normalized)) fail(`invalid ${name}: ${JSON.stringify(value)}`);
  return normalized;
}

function strictVersion(name, value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !isStrictSemver(normalized)) fail(`invalid ${name}: ${JSON.stringify(value)}`);
  return normalized;
}

function equal(name, actual, expected) {
  if (String(actual) !== String(expected)) fail(`${name} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

// actions/upload-artifact emits a bare hex digest; the Actions REST API reports the same value as
// sha256:<hex>. Canonicalize to the API's form so a receipt's stored digest compares equal to the
// artifact metadata the finalizer independently observes.
function digest(name, value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized === "string" && BARE_SHA256.test(normalized)) return `sha256:${normalized}`;
  return string(name, normalized, SHA256);
}

function stageIds(value, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) stageIds(child, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "stageId") found.push(child);
      else stageIds(child, found);
    }
  }
  return found;
}

/** npm 11.15 emits JSON with one package entry containing `stageId`. */
export function parseStagePublishJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`npm stage publish did not emit valid JSON: ${error.message}`);
  }
  const found = stageIds(parsed);
  if (found.length !== 1) {
    throw new Error(`npm stage publish JSON must contain exactly one stageId, found ${found.length}`);
  }
  const id = found[0];
  if (typeof id !== "string" || !LIVE_STAGE_ID.test(id)) {
    throw new Error(`npm stage publish returned an invalid stageId: ${JSON.stringify(id)}`);
  }
  return id;
}

/** npm stage download chooses this filename; the command has no --out option. */
export function stageDownloadFilename(version, stageId) {
  return stageDownloadFilenameForTarget(defaultReleaseTargets().bridge, version, stageId);
}

export function stageDownloadFilenameFor(targetId, version, stageId) {
  strictVersion("version", version);
  string("stage id", stageId, LIVE_STAGE_ID);
  const target = defaultReleaseTargets()[targetId];
  if (!target) fail(`unknown release target ${JSON.stringify(targetId)}`);
  return stageDownloadFilenameForTarget(assertWorkflowContract(target), version, stageId);
}

function resolveTargetFromFields(fields) {
  try {
    return resolveDeclaredTarget({
      targetId: fields.target,
      packageName: fields.packageName,
      targets: defaultReleaseTargets(),
      context: "stage receipt target",
      workflowContract: "full",
    });
  } catch (error) {
    fail(error.message);
  }
}

function resolveTargetFromCandidate(candidate, prepared = {}) {
  try {
    return resolveDeclaredTarget({
      targetId: candidate?.target ?? prepared.target,
      packageName: candidate?.package?.name ?? prepared.package ?? candidate?.build_identity?.package?.name,
      targets: defaultReleaseTargets(),
      context: "finalizer proof target",
      workflowContract: "full",
    });
  } catch (error) {
    fail(error.message);
  }
}

function normalizedAssets(assets) {
  if (!Array.isArray(assets) || assets.length !== 2) fail("draft must contain exactly two retained assets");
  return assets
    .map((asset) => ({
      id: string("asset id", asset?.id),
      name: string("asset name", asset?.name),
      digest: digest("asset digest", asset?.digest),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildStageReceipt(fields) {
  const target = resolveTargetFromFields(fields);
  const version = strictVersion("version", fields.version);
  const tag = string("tag", fields.tag);
  equal("tag", tag, `v${version}`);
  const sourceCommit = string("source commit", fields.sourceCommit, COMMIT);
  const runId = string("run id", fields.runId);
  const artifactId = string("candidate artifact id", fields.artifactId);
  const artifactDigest = digest("candidate artifact digest", fields.artifactDigest);
  const tarballFilename = string("tarball filename", fields.tarballFilename);
  equal("tarball filename", tarballFilename, releaseTarballFilename(target, version));
  const tarballSha256 = digest("tarball SHA-256", fields.tarballSha256);
  const manifestSha256 = digest("manifest SHA-256", fields.manifestSha256);
  const integrity = string("npm integrity", fields.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  const draftReleaseId = string("draft release id", fields.draftReleaseId);
  const draftAssets = normalizedAssets(fields.draftAssets);
  const stageId = string("stage id", fields.stageId, fields.stageId === DRY_RUN_STAGE_ID ? TOKEN : LIVE_STAGE_ID);
  const stageTag = string("stage tag", fields.policyTag);

  const assetByName = new Map(draftAssets.map((asset) => [asset.name, asset]));
  equal("draft tarball asset digest", assetByName.get(tarballFilename)?.digest, tarballSha256);
  equal("draft manifest asset digest", assetByName.get("candidate.json")?.digest, manifestSha256);

  return {
    schema: RELEASE_STAGE_RECEIPT_SCHEMA,
    state: "staged",
    prepared: {
      target: target.id,
      package: target.package.name,
      version,
      tag,
      source_commit: sourceCommit,
      run_id: runId,
      artifact: {
        id: artifactId,
        name: `release-candidate-${runId}`,
        digest: artifactDigest,
      },
      tarball: { filename: tarballFilename, sha256: tarballSha256, integrity },
      manifest_sha256: manifestSha256,
    },
    draft: { release_id: draftReleaseId, assets: draftAssets },
    stage: {
      id: stageId,
      tag: stageTag,
      download_filename: stageId === DRY_RUN_STAGE_ID ? null : stageDownloadFilenameForTarget(target, version, stageId),
    },
  };
}

function verifyArtifactMetadata(label, metadata, expected) {
  equal(`${label} id`, metadata?.id, expected.id);
  equal(`${label} name`, metadata?.name, expected.name);
  equal(`${label} digest`, metadata?.digest, expected.digest);
  equal(`${label} workflow run`, metadata?.workflow_run?.id, expected.runId);
  equal(`${label} source commit`, metadata?.workflow_run?.head_sha, expected.commit);
  if (metadata?.expired !== false) fail(`${label} is expired or lacks expired:false`);
}

/**
 * Verify every independently observed part of the finalizer chain. Returns normalized values only
 * after candidate bytes, artifact API metadata, stage receipt, dispatch inputs, and draft assets
 * all agree.
 */
export function verifyFinalizerChain({
  candidate,
  receipt,
  candidateArtifact,
  receiptArtifact,
  release,
  dispatch,
  actualTarballSha256,
  actualManifestSha256,
}) {
  if (candidate?.schema !== RELEASE_CANDIDATE_SCHEMA) fail("candidate schema is not v1");
  if (receipt?.schema !== RELEASE_STAGE_RECEIPT_SCHEMA || receipt?.state !== "staged") {
    fail("stage receipt schema/state is not staged v2");
  }

  const prepared = receipt.prepared ?? {};
  const target = resolveTargetFromCandidate(candidate, prepared);
  equal("receipt target", prepared.target, target.id);
  equal("receipt package", prepared.package, target.package.name);
  equal("candidate target", candidate.target, target.id);
  equal("candidate package", candidate.package?.name, target.package.name);
  strictVersion("receipt version", prepared.version);
  equal("receipt tag", prepared.tag, `v${prepared.version}`);
  equal("receipt tarball filename", prepared.tarball?.filename, releaseTarballFilename(target, prepared.version));
  equal("dispatch run id", dispatch.runId, prepared.run_id);
  equal("dispatch candidate artifact id", dispatch.artifactId, prepared.artifact?.id);
  equal("dispatch stage id", dispatch.stageId, receipt.stage?.id);
  equal("dispatch draft release id", dispatch.draftReleaseId, receipt.draft?.release_id);
  equal("dispatch version", dispatch.version, prepared.version);

  equal("candidate version", candidate.version, prepared.version);
  equal("candidate tag", candidate.tag, prepared.tag);
  equal("candidate source commit", candidate.source?.commit, prepared.source_commit);
  if (candidate.source?.dirty !== false) fail("candidate source is not recorded clean");
  equal("candidate tarball filename", candidate.tarball?.filename, prepared.tarball?.filename);
  equal("candidate tarball SHA-256", candidate.tarball?.sha256, prepared.tarball?.sha256);
  equal("candidate npm integrity", candidate.tarball?.integrity, prepared.tarball?.integrity);
  equal("downloaded tarball SHA-256", actualTarballSha256, prepared.tarball?.sha256);
  equal("downloaded manifest SHA-256", actualManifestSha256, prepared.manifest_sha256);

  verifyArtifactMetadata("candidate artifact", candidateArtifact, {
    ...prepared.artifact,
    runId: prepared.run_id,
    commit: prepared.source_commit,
  });
  verifyArtifactMetadata("stage receipt artifact", receiptArtifact, {
    id: dispatch.stageReceiptArtifactId,
    name: `release-stage-receipt-${prepared.run_id}`,
    digest: digest("stage receipt artifact digest", dispatch.stageReceiptArtifactDigest),
    runId: prepared.run_id,
    commit: prepared.source_commit,
  });

  equal("draft release id", release?.id, receipt.draft?.release_id);
  if (release?.draft !== true) fail("GitHub release is not an unpublished draft");
  equal("draft tag", release?.tag_name, prepared.tag);
  // Operator receipt/status assets (the ordering gate's evidence) are the ONLY extras tolerated
  // beyond the two recorded core assets; any other extra still fails the exactly-two check.
  const coreAssets = (Array.isArray(release?.assets) ? release.assets : []).filter((asset) => (
    !parseAuxiliaryReleaseAssetName(asset?.name, { mode: "finalize", currentStageId: receipt.stage.id })
  ));
  const observedAssets = normalizedAssets(coreAssets);
  const recordedAssets = normalizedAssets(receipt.draft?.assets);
  if (JSON.stringify(observedAssets) !== JSON.stringify(recordedAssets)) fail("draft release assets differ from stage receipt");

  return {
    schema: RELEASE_FINALIZER_PROOF_SCHEMA,
    target: target.id,
    package: target.package.name,
    version: prepared.version,
    tag: prepared.tag,
    source_commit: prepared.source_commit,
    stage_id: receipt.stage.id,
    draft_release_id: receipt.draft.release_id,
    tarball_sha256: prepared.tarball.sha256,
    integrity: prepared.tarball.integrity,
    core_assets: observedAssets,
  };
}
