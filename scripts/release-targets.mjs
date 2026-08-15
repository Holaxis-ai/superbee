import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStrictSemver, compareStrictSemver } from "./strict-semver.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const RELEASE_TARGET_SCHEMA = "superbee.release-targets.v1";
export const CUTOVER_CONTRACT_SCHEMA = "superbee.cutover-contract.v1";
export const RELEASE_CANDIDATE_SCHEMA = "superbee.release-candidate.v1";
export const RELEASE_STAGE_RECEIPT_SCHEMA = "superbee.stage-receipt.v1";
export const RELEASE_FINALIZER_PROOF_SCHEMA = "superbee.finalizer-chain-proof.v1";
export const REGISTRY_PROOF_SCHEMA = "superbee.registry-proof.v1";

const TARGET_ID = /^[a-z][a-z0-9-]*$/;
const TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const DIRECTORY_SEGMENT = /^@?[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const POLICY_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CUTOVER_CONTRACT_KEYS = ["schema", "semantics", "reviewed_at", "review", "targets"];

export const DEFAULT_RELEASE_TARGETS_PATH = path.join(repoRoot, "release", "targets.json");
export const DEFAULT_BURNED_VERSIONS_PATH = path.join(repoRoot, "release", "burned-versions.json");
export const DEFAULT_CUTOVER_CONTRACT_PATH = path.join(repoRoot, "release", "cutover-contract.json");
const CUTOVER_CONTRACT_LABEL = "release/cutover-contract.json";
const DEFAULT_CLI_PACKAGE_PATH = path.join(repoRoot, "packages", "cli", "package.json");

export function assertTargetId(targetId) {
  if (typeof targetId !== "string" || !TARGET_ID.test(targetId)) {
    throw new Error(`invalid release target: ${JSON.stringify(targetId)}`);
  }
  return targetId;
}

export function assertVersion(value) {
  return assertStrictSemver(value, "release version");
}

export function assertTagForVersion(tag, version) {
  if (tag !== `v${version}`) throw new Error(`release tag ${tag} != v${version}`);
  return tag;
}

export function tarballFilename(target, version) {
  assertVersion(version);
  return `${target.tarball_basename}-${version}.tgz`;
}

export function stageDownloadFilenameForTarget(target, version, stageId) {
  assertVersion(version);
  if (typeof stageId !== "string" || !TOKEN.test(stageId)) {
    throw new Error(`invalid stage id: ${JSON.stringify(stageId)}`);
  }
  return `${target.tarball_basename}-${version}-${stageId}.tgz`;
}

function normalizeTarget(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`release target ${id} must be an object`);
  const packageInfo = raw.package;
  if (!packageInfo || typeof packageInfo !== "object" || Array.isArray(packageInfo)) {
    throw new Error(`release target ${id} must define package metadata`);
  }
  const target = {
    id,
    package: {
      name: packageInfo.name,
      directory: packageInfo.directory,
    },
    artifact: raw.artifact,
    bins: raw.bins,
    tarball_basename: raw.tarball_basename,
    allow_production: raw.allow_production === true,
    workflow_contract: raw.workflow_contract ?? "full",
    expected_commands: raw.expected_commands,
    preferred_command: raw.preferred_command,
  };
  if (!TARGET_ID.test(id)) throw new Error(`invalid release target id ${JSON.stringify(id)}`);
  if (typeof target.package.name !== "string" || !PACKAGE.test(target.package.name)) {
    throw new Error(`release target ${id} has invalid package name`);
  }
  if (!Array.isArray(target.package.directory) || !target.package.directory.every((p) => typeof p === "string" && DIRECTORY_SEGMENT.test(p))) {
    throw new Error(`release target ${id} has invalid package directory`);
  }
  if (typeof target.artifact !== "string" || target.artifact !== "dist/superbee.mjs") {
    throw new Error(`release target ${id} must use dist/superbee.mjs`);
  }
  if (!target.bins || typeof target.bins !== "object" || Array.isArray(target.bins)) {
    throw new Error(`release target ${id} has invalid bin map`);
  }
  for (const [bin, artifact] of Object.entries(target.bins)) {
    if (!TOKEN.test(bin) || artifact !== target.artifact) throw new Error(`release target ${id} has invalid bin ${bin}`);
  }
  if (id === "bridge" && Object.hasOwn(target.bins, "superbee")) {
    throw new Error("bridge release target must not own the superbee bin");
  }
  if (id.startsWith("successor-") && !Object.hasOwn(target.bins, "superbee")) {
    throw new Error("successor release target must own the superbee bin");
  }
  if (typeof target.tarball_basename !== "string" || !TOKEN.test(target.tarball_basename)) {
    throw new Error(`release target ${id} has invalid tarball basename`);
  }
  if (!["full", "identity-only"].includes(target.workflow_contract)) {
    throw new Error(`release target ${id} has invalid workflow contract`);
  }
  if (target.allow_production && target.workflow_contract !== "full") {
    throw new Error(`production release target ${id} must use the full workflow contract`);
  }
  if (!Array.isArray(target.expected_commands) || !target.expected_commands.every((c) => typeof c === "string" && Object.hasOwn(target.bins, c))) {
    throw new Error(`release target ${id} has invalid expected command list`);
  }
  if (typeof target.preferred_command !== "string" || !Object.hasOwn(target.bins, target.preferred_command)) {
    throw new Error(`release target ${id} has invalid preferred command`);
  }
  return target;
}

function normalizeTuple(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`release tuple ${id} must be an object`);
  const targetId = assertTargetId(raw.target);
  const version = assertVersion(raw.version);
  const tag = typeof raw.tag === "string" ? raw.tag : "";
  assertTagForVersion(tag, version);
  if (typeof raw.package !== "string" || !PACKAGE.test(raw.package)) throw new Error(`release tuple ${id} has invalid package`);
  const outcome = raw.outcome;
  if (!["reject", "approve", "publish"].includes(outcome)) throw new Error(`release tuple ${id} has invalid outcome`);
  const production = raw.production === true;
  const publication = raw.publication;
  if (!publication || typeof publication !== "object" || Array.isArray(publication) || Object.keys(publication).sort().join(",") !== "github_latest,npm_promote_tag,npm_tag") {
    throw new Error(`release tuple ${id} requires explicit publication policy`);
  }
  if (publication.npm_tag !== null && !["latest", "next"].includes(publication.npm_tag)) {
    throw new Error(`release tuple ${id} has invalid npm publication tag`);
  }
  if (publication.npm_promote_tag !== null && !["latest", "next"].includes(publication.npm_promote_tag)) {
    throw new Error(`release tuple ${id} has invalid npm promotion tag`);
  }
  if (typeof publication.github_latest !== "boolean") throw new Error(`release tuple ${id} has invalid GitHub latest policy`);
  if (outcome === "publish" && publication.npm_tag === null) throw new Error(`published release tuple ${id} requires an npm publication tag`);
  if (outcome !== "publish" && publication.npm_tag !== null) throw new Error(`non-publish release tuple ${id} must not set an npm publication tag`);
  if (publication.npm_promote_tag !== null && publication.npm_tag === null) {
    throw new Error(`release tuple ${id} cannot promote a dist-tag for a version it never publishes`);
  }
  if (publication.github_latest && outcome !== "publish") {
    throw new Error(`non-publish release tuple ${id} must not claim the GitHub latest release`);
  }
  return { id, target: targetId, package: raw.package, version, tag, outcome, production, publication: { npm_tag: publication.npm_tag, npm_promote_tag: publication.npm_promote_tag, github_latest: publication.github_latest } };
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${sortedKeys(value).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`cutover policy surface cannot encode ${typeof value}`);
  return encoded;
}

/**
 * The slice of a normalized manifest a human reviewer approves for the cutover: who publishes,
 * with what release authority, under which publication policy. Versions and tags are deliberately
 * excluded - they move within an already-approved target and are governed by the burn ledger, the
 * functional successor floor, and the tag/version binding.
 */
export function cutoverPolicySurface(manifest, id) {
  const target = manifest?.targets?.[id];
  const tuple = manifest?.allowed_tuples?.[id];
  if (!target || !tuple) throw new Error(`release target ${id} has no reviewable cutover surface`);
  return {
    target: id,
    package: target.package.name,
    allow_production: target.allow_production,
    workflow_contract: target.workflow_contract,
    outcome: tuple.outcome,
    production: tuple.production,
    publication: {
      npm_tag: tuple.publication.npm_tag,
      npm_promote_tag: tuple.publication.npm_promote_tag,
      github_latest: tuple.publication.github_latest,
    },
  };
}

export function cutoverPolicyDigest(manifest, id) {
  return `sha256:${createHash("sha256").update(canonicalJson(cutoverPolicySurface(manifest, id))).digest("hex")}`;
}

export function normalizeCutoverContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CUTOVER_CONTRACT_LABEL} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!CUTOVER_CONTRACT_KEYS.includes(key)) throw new Error(`${CUTOVER_CONTRACT_LABEL} has unsupported key ${JSON.stringify(key)}`);
  }
  if (raw.schema !== CUTOVER_CONTRACT_SCHEMA) {
    throw new Error(`${CUTOVER_CONTRACT_LABEL} schema ${JSON.stringify(raw.schema)} != ${CUTOVER_CONTRACT_SCHEMA}`);
  }
  const targetsRaw = raw.targets;
  if (!targetsRaw || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) {
    throw new Error(`${CUTOVER_CONTRACT_LABEL} requires an approved target roster`);
  }
  const approved = {};
  for (const [id, entry] of Object.entries(targetsRaw)) {
    assertTargetId(id);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || sortedKeys(entry).join(",") !== "policy_sha256" || !POLICY_DIGEST.test(entry.policy_sha256)) {
      throw new Error(`${CUTOVER_CONTRACT_LABEL} entry ${id} requires exactly one sha256 policy digest`);
    }
    approved[id] = { policy_sha256: entry.policy_sha256 };
  }
  if (Object.keys(approved).length === 0) throw new Error(`${CUTOVER_CONTRACT_LABEL} must approve at least one release target`);
  // Normalizing to the same shape it accepts keeps the check idempotent: a caller that has already
  // read and validated the contract can hand it straight back without weakening the assertion.
  return { schema: CUTOVER_CONTRACT_SCHEMA, targets: approved };
}

/**
 * Bind a structurally valid manifest to the detached human approval. The manifest stays the only
 * place policy values are written; the contract records that a reviewer approved exactly this
 * roster and exactly these values, and holds digests rather than copies so no value is declared
 * twice. Editing release/targets.json alone therefore cannot enroll a target or move a
 * publication policy - it invalidates an approval that lives in a different, separately reviewed
 * file.
 */
function assertApprovedCutover(manifest, contract) {
  const approved = normalizeCutoverContract(contract);
  const declaredIds = sortedKeys(manifest.targets);
  const approvedIds = sortedKeys(approved.targets);
  if (JSON.stringify(declaredIds) !== JSON.stringify(approvedIds)) {
    const unapproved = declaredIds.filter((id) => !approvedIds.includes(id));
    const retired = approvedIds.filter((id) => !declaredIds.includes(id));
    throw new Error(
      `release target roster is not the approved cutover roster (unapproved: ${unapproved.join(",") || "none"}; unlisted: ${retired.join(",") || "none"}); re-approval is a separate reviewed change to ${CUTOVER_CONTRACT_LABEL}`,
    );
  }
  const drifted = declaredIds
    .map((id) => ({ id, declared: cutoverPolicyDigest(manifest, id), approved: approved.targets[id].policy_sha256 }))
    .filter((entry) => entry.declared !== entry.approved);
  if (drifted.length > 0) {
    const detail = drifted
      .map((entry) => `${entry.id}: approved ${entry.approved}, declared ${entry.declared} for ${canonicalJson(cutoverPolicySurface(manifest, entry.id))}`)
      .join("; ");
    throw new Error(
      `release publication policy is not approved by the cutover contract (${detail}); re-approval is a separate reviewed change to ${CUTOVER_CONTRACT_LABEL}`,
    );
  }
  return manifest;
}

export function loadCutoverContractSync(file = DEFAULT_CUTOVER_CONTRACT_PATH) {
  return normalizeCutoverContract(JSON.parse(readFileSync(file, "utf8")));
}

export async function loadCutoverContract(file = DEFAULT_CUTOVER_CONTRACT_PATH) {
  return normalizeCutoverContract(JSON.parse(await readFile(file, "utf8")));
}

function normalizeManifestStructure(raw, burnedVersions) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("release target manifest must be an object");
  if (raw.schema !== RELEASE_TARGET_SCHEMA) throw new Error(`release target manifest schema ${JSON.stringify(raw.schema)} != ${RELEASE_TARGET_SCHEMA}`);
  const functionalSuccessorFloor = assertVersion(raw.functional_successor_floor);
  const targetsRaw = raw.targets;
  if (!targetsRaw || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) throw new Error("release target manifest requires targets");
  const targets = {};
  for (const [id, target] of Object.entries(targetsRaw)) targets[id] = normalizeTarget(target, id);
  if (Object.keys(targets).length === 0) throw new Error("release target manifest must contain at least one target");
  const tuplesRaw = raw.allowed_tuples;
  if (!tuplesRaw || typeof tuplesRaw !== "object" || Array.isArray(tuplesRaw)) throw new Error("release target manifest requires allowed_tuples");
  const allowedTuples = {};
  for (const [id, tuple] of Object.entries(tuplesRaw)) {
    const normalized = normalizeTuple(tuple, id);
    if (normalized.target !== id) throw new Error(`release tuple ${id} must target ${id}`);
    const target = targets[normalized.target];
    if (!target) throw new Error(`release tuple ${id} references missing target ${normalized.target}`);
    if (normalized.package !== target.package.name) throw new Error(`release tuple ${id} package ${normalized.package} != target ${target.package.name}`);
    if (normalized.production && !target.allow_production) throw new Error(`release tuple ${id} marks non-production target as production`);
    if (!normalized.production && (normalized.package === "@holaxis/aslite" || normalized.package === "superbee")) {
      throw new Error(`rehearsal tuple ${id} must not target production package ${normalized.package}`);
    }
    if (burnedVersions.includes(normalized.version)) {
      throw new Error(`release tuple ${id} uses burned version ${normalized.version}`);
    }
    allowedTuples[id] = normalized;
  }
  if (JSON.stringify(sortedKeys(allowedTuples)) !== JSON.stringify(sortedKeys(targets))) {
    throw new Error("release target manifest target ids and allowlisted tuple ids must match exactly");
  }
  const versions = Object.values(allowedTuples).map((tuple) => tuple.version);
  const tags = Object.values(allowedTuples).map((tuple) => tuple.tag);
  if (new Set(versions).size !== versions.length || new Set(tags).size !== tags.length) throw new Error("reviewed release tuple versions and tags must be pairwise distinct");
  const githubLatest = Object.values(allowedTuples).filter((tuple) => tuple.publication.github_latest).map((tuple) => tuple.id).sort();
  if (githubLatest.length > 1) {
    throw new Error(`release target manifest declares ${githubLatest.length} GitHub latest releases (${githubLatest.join(", ")}); the repository has exactly one`);
  }
  const stableSuccessor = allowedTuples["successor-stable"];
  if (!stableSuccessor) throw new Error("release target manifest requires a successor-stable tuple for functional successor floor review");
  if (compareStrictSemver(stableSuccessor.version, functionalSuccessorFloor) === -1) {
    throw new Error(
      `reviewed stable successor tuple version ${stableSuccessor.version} must be at or above functional successor floor ${functionalSuccessorFloor}`,
    );
  }
  return {
    schema: RELEASE_TARGET_SCHEMA,
    functional_successor_floor: functionalSuccessorFloor,
    targets,
    allowed_tuples: allowedTuples,
  };
}

/**
 * There is no exported path to a normalized manifest that skips the approval check: every release
 * consumer goes through here, and the contract defaults to the reviewed one on disk rather than to
 * "unchecked" so a caller cannot opt out by omission.
 */
export function normalizeReleaseTargets(raw, { burnedVersions = [], contract = loadCutoverContractSync() } = {}) {
  return assertApprovedCutover(normalizeManifestStructure(raw, burnedVersions), contract);
}

function normalizeBurnedVersions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.burned)) {
    throw new Error("burned-versions declaration requires burned: []");
  }
  const versions = [];
  for (const entry of raw.burned) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.version !== "string" || typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error("each burned-versions entry requires version and non-empty reason");
    }
    assertVersion(entry.version);
    if (versions.includes(entry.version)) throw new Error(`burned version ${entry.version} is declared twice`);
    versions.push(entry.version);
  }
  return versions;
}

async function loadBurnedVersions(file) {
  return normalizeBurnedVersions(JSON.parse(await readFile(file, "utf8")));
}

async function assertCheckedInCliVersion(manifest, file) {
  const cli = JSON.parse(await readFile(file, "utf8"));
  const successor = manifest.allowed_tuples["successor-stable"];
  if (cli?.name !== successor.package || cli?.version !== successor.version) {
    throw new Error(
      `packages/cli/package.json must declare successor ${successor.package}@${successor.version}; observed ${cli?.name ?? "unknown"}@${cli?.version ?? "unknown"}`,
    );
  }
}

// The burn ledger and the checked-in CLI describe the manifest's own directory, so they follow the
// manifest path; the cutover approval describes the reviewed source tree, so it never does - a
// manifest handed to this loader from anywhere is measured against the approval under review.
export async function loadReleaseTargets(file = DEFAULT_RELEASE_TARGETS_PATH, {
  burnedFile = file === DEFAULT_RELEASE_TARGETS_PATH ? DEFAULT_BURNED_VERSIONS_PATH : null,
  cliPackageFile = file === DEFAULT_RELEASE_TARGETS_PATH ? DEFAULT_CLI_PACKAGE_PATH : null,
  contractFile = DEFAULT_CUTOVER_CONTRACT_PATH,
} = {}) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const burnedVersions = burnedFile ? await loadBurnedVersions(burnedFile) : [];
  const manifest = normalizeReleaseTargets(raw, { burnedVersions, contract: await loadCutoverContract(contractFile) });
  if (cliPackageFile) await assertCheckedInCliVersion(manifest, cliPackageFile);
  return manifest;
}

/** Lazy synchronous authority for pure release emitters; never runs at import time. */
export function defaultReleaseManifest() {
  const raw = JSON.parse(readFileSync(DEFAULT_RELEASE_TARGETS_PATH, "utf8"));
  const burned = normalizeBurnedVersions(JSON.parse(readFileSync(DEFAULT_BURNED_VERSIONS_PATH, "utf8")));
  return Object.freeze(normalizeReleaseTargets(raw, { burnedVersions: burned }));
}

/** Lazy synchronous compatibility helper for pure release emitters; never runs at import time. */
export function defaultReleaseTargets() {
  return Object.freeze(defaultReleaseManifest().targets);
}

/** Compatibility lookup only: shared package names intentionally remain ambiguous. */
export function targetFromPackageName(packageName, targets = defaultReleaseTargets()) {
  const matches = Object.values(targets).filter((target) => target.package.name === packageName);
  return matches.length === 1 ? matches[0].id : null;
}

/** Release identity is never coerced: a present non-string is a caller defect, not an absent field. */
function assertDeclaredIdentity(label, value) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string; received ${JSON.stringify(value) ?? typeof value}`);
  }
  return value;
}

export function resolveDeclaredTarget({
  targetId,
  packageName,
  targets = defaultReleaseTargets(),
  context = "release target",
  workflowContract,
  fallbackTargetId,
} = {}) {
  // Dropping a malformed identity would resolve some other target's package, so both identity
  // fields are rejected before either one is allowed to stand in for the other.
  assertDeclaredIdentity(`${context} target id`, targetId);
  assertDeclaredIdentity(`${context} package name`, packageName);
  const normalizedTargetId = targetId ?? (packageName === undefined ? fallbackTargetId : undefined);
  const normalizedPackageName = packageName;
  let target;
  if (normalizedTargetId !== undefined) {
    target = targets[assertTargetId(normalizedTargetId)];
    if (!target) throw new Error(`${context} ${JSON.stringify(normalizedTargetId)} is not a declared release target`);
  } else if (normalizedPackageName !== undefined) {
    const inferredTargetId = targetFromPackageName(normalizedPackageName, targets);
    if (inferredTargetId === null) {
      const matches = Object.values(targets)
        .filter((candidate) => candidate.package.name === normalizedPackageName)
        .map((candidate) => candidate.id)
        .sort();
      if (matches.length > 1) {
        throw new Error(`${context} package ${normalizedPackageName} is ambiguous across targets ${matches.join(", ")}; explicit target required`);
      }
      throw new Error(`${context} package ${normalizedPackageName} does not match any declared release target`);
    }
    target = targets[inferredTargetId];
  } else {
    throw new Error(`${context} requires an explicit target`);
  }
  if (normalizedPackageName !== undefined && normalizedPackageName !== target.package.name) {
    throw new Error(`${context} package ${normalizedPackageName} does not match target ${target.package.name}`);
  }
  return workflowContract ? assertWorkflowContract(target, workflowContract) : target;
}

export function assertWorkflowContract(target, workflowContract = "full") {
  if (!target || target.workflow_contract !== workflowContract) {
    throw new Error(`release target ${target?.id ?? "<unknown>"} requires workflow contract ${workflowContract}`);
  }
  return target;
}

/** Explicit build-time policy: only reviewed production targets may consult superbee. */
export function updatePolicyForTarget(target) {
  if (!target || target.allow_production !== true) return { enabled: false };
  return { enabled: true };
}

export async function resolveReleaseTarget(targetId, { manifestPath = DEFAULT_RELEASE_TARGETS_PATH } = {}) {
  const manifest = await loadReleaseTargets(manifestPath);
  const target = manifest.targets[assertTargetId(targetId)];
  if (!target) throw new Error(`release target ${targetId} is not listed in ${path.relative(repoRoot, manifestPath)}`);
  return target;
}

export function assertAllowedTuple(manifest, { target, packageName, version, tag }) {
  const targetId = assertTargetId(target);
  const found = Object.values(manifest.allowed_tuples).find((tuple) =>
    tuple.target === targetId &&
    tuple.package === packageName &&
    tuple.version === version &&
    tuple.tag === tag
  );
  if (!found) {
    throw new Error(`release tuple target=${targetId} package=${packageName} version=${version} tag=${tag} is not allowlisted`);
  }
  return found;
}

export function resolveAllowedTuple(manifest, { target, version, tag }) {
  const targetId = assertTargetId(target);
  const found = Object.values(manifest.allowed_tuples).find((tuple) =>
    tuple.target === targetId &&
    tuple.version === version &&
    tuple.tag === tag
  );
  if (!found) {
    throw new Error(`release tuple target=${targetId} version=${version} tag=${tag} is not allowlisted`);
  }
  return found;
}

export function resolveAllowedTupleByTarget(manifest, { target }) {
  const targetId = assertTargetId(target);
  const found = Object.values(manifest.allowed_tuples).filter((tuple) => tuple.target === targetId);
  if (found.length !== 1) {
    throw new Error(`release target ${targetId} must match exactly one allowlisted tuple for dispatch, found ${found.length}`);
  }
  return found[0];
}

export function resolveAllowedTupleByTag(manifest, { tag }) {
  const found = Object.values(manifest.allowed_tuples).filter((tuple) => tuple.tag === tag);
  if (found.length !== 1) {
    throw new Error(`release tag ${tag} must match exactly one allowlisted tuple, found ${found.length}`);
  }
  return found[0];
}
