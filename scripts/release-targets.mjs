import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const RELEASE_TARGET_SCHEMA = "superbee.release-targets.v1";
export const RELEASE_CANDIDATE_SCHEMA = "superbee.release-candidate.v1";
export const RELEASE_STAGE_RECEIPT_SCHEMA = "superbee.stage-receipt.v1";
export const RELEASE_FINALIZER_PROOF_SCHEMA = "superbee.finalizer-chain-proof.v1";
export const REGISTRY_PROOF_SCHEMA = "superbee.registry-proof.v1";

const TARGET_ID = /^[a-z][a-z0-9-]*$/;
const TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const DIRECTORY_SEGMENT = /^@?[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export const DEFAULT_RELEASE_TARGETS_PATH = path.join(repoRoot, "release", "targets.json");

export function assertTargetId(targetId) {
  if (typeof targetId !== "string" || !TARGET_ID.test(targetId)) {
    throw new Error(`invalid release target: ${JSON.stringify(targetId)}`);
  }
  return targetId;
}

export function assertVersion(value) {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`invalid release version: ${JSON.stringify(value)}`);
  }
  return value;
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
  if (id === "successor" && !Object.hasOwn(target.bins, "superbee")) {
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
  return { id, target: targetId, package: raw.package, version, tag, outcome, production };
}

export function normalizeReleaseTargets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("release target manifest must be an object");
  if (raw.schema !== RELEASE_TARGET_SCHEMA) throw new Error(`release target manifest schema ${JSON.stringify(raw.schema)} != ${RELEASE_TARGET_SCHEMA}`);
  const functionalSuccessorFloor = assertVersion(raw.functional_successor_floor);
  const targetsRaw = raw.targets;
  if (!targetsRaw || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) throw new Error("release target manifest requires targets");
  const targets = {};
  for (const [id, target] of Object.entries(targetsRaw)) targets[id] = normalizeTarget(target, id);
  for (const id of ["bridge", "successor"]) if (!targets[id]) throw new Error(`release target manifest missing ${id}`);
  const tuplesRaw = raw.allowed_tuples;
  if (!tuplesRaw || typeof tuplesRaw !== "object" || Array.isArray(tuplesRaw)) throw new Error("release target manifest requires allowed_tuples");
  const allowedTuples = {};
  for (const [id, tuple] of Object.entries(tuplesRaw)) {
    const normalized = normalizeTuple(tuple, id);
    const target = targets[normalized.target];
    if (!target) throw new Error(`release tuple ${id} references missing target ${normalized.target}`);
    if (normalized.package !== target.package.name) throw new Error(`release tuple ${id} package ${normalized.package} != target ${target.package.name}`);
    if (normalized.production && !target.allow_production) throw new Error(`release tuple ${id} marks non-production target as production`);
    if (!normalized.production && (normalized.package === "@holaxis/aslite" || normalized.package === "superbee")) {
      throw new Error(`rehearsal tuple ${id} must not target production package ${normalized.package}`);
    }
    allowedTuples[id] = normalized;
  }
  if (allowedTuples.bridge?.version && allowedTuples.successor?.version && allowedTuples.bridge.version === allowedTuples.successor.version) {
    throw new Error("bridge and successor versions must differ because v<version> tags are immutable");
  }
  if (allowedTuples.successor?.version !== functionalSuccessorFloor) {
    throw new Error(
      `functional successor floor ${functionalSuccessorFloor} must equal the reviewed successor tuple version ${allowedTuples.successor?.version ?? "<missing>"}`,
    );
  }
  return {
    schema: RELEASE_TARGET_SCHEMA,
    functional_successor_floor: functionalSuccessorFloor,
    targets,
    allowed_tuples: allowedTuples,
  };
}

export async function loadReleaseTargets(file = DEFAULT_RELEASE_TARGETS_PATH) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  return normalizeReleaseTargets(raw);
}

// The checked-in manifest is the release authority. Keeping a hand-maintained in-code subset
// caused declared rehearsal targets to disappear after candidate creation.
export const DEFAULT_TARGETS = Object.freeze((await loadReleaseTargets()).targets);

export function targetFromPackageName(packageName) {
  const matches = Object.values(DEFAULT_TARGETS).filter((target) => target.package.name === packageName);
  return matches.length === 1 ? matches[0].id : null;
}

export function assertWorkflowContract(target, workflowContract = "full") {
  if (!target || target.workflow_contract !== workflowContract) {
    throw new Error(`release target ${target?.id ?? "<unknown>"} requires workflow contract ${workflowContract}`);
  }
  return target;
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
