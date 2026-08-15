// Pure emitter of the staged-release operations. Each executable operation is returned as a
// validated ARGV ARRAY (never a shell string): the CLI runs them with execFile — no shell, no
// word-splitting, no metacharacter interpretation — so an operation value can never inject a
// command. Every interpolated value is validated at construction (version = strict SemVer;
// ids/tags/filenames = a safe charset), so even the human-readable `command` display strings and
// the operator INSTRUCTION strings are built only from conforming inputs. A non-conforming value
// throws (the CLI turns that into a non-zero exit).
//
// Normative source: version-update-protocols.md §5. Single authority so the workflow, the receipt
// instructions, and the tests never drift.

import {
  defaultReleaseManifest,
  defaultReleaseTargets,
  resolveAllowedTupleByTarget,
  resolveDeclaredTarget,
  stageDownloadFilenameForTarget,
} from "./release-targets.mjs";
import { assertStrictSemver } from "./strict-semver.mjs";

/**
 * Which package an operation names is NEVER defaulted. A missing target used to resolve to the
 * bridge, so a superbee rollback invoked without one silently emitted registry commands against
 * @holaxis/aslite. The shared resolver fails closed on an absent, unknown, non-string, or
 * identity-only target.
 */
function targetFor(targetId) {
  return resolveDeclaredTarget({
    targetId,
    targets: defaultReleaseTargets(),
    context: "release operation target",
    workflowContract: "full",
  });
}

// A safe token for ids/tags/filenames: alphanumerics and . _ - only, and NOT dash-leading — a
// flag-shaped value (`-v`, `--registry=…`) must never enter an execFile argv as an option-lookalike.
const TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
// A digest is `sha256:` + 64 lowercase hex (or bare 64 hex).
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;

export function assertVersion(value) {
  try { return assertStrictSemver(value); }
  catch { throw new Error(`invalid version (must be strict SemVer): ${JSON.stringify(value)}`); }
}
export function assertToken(name, value) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new Error(`invalid ${name} (must match [A-Za-z0-9._-], no leading dash): ${JSON.stringify(value)}`);
  }
  return value;
}
function assertSha256(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`invalid tarball SHA-256: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertBooleanish(name, value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
}

/** Shell-quote an argv element for DISPLAY only (never for execution). */
function q(arg) {
  if (/^[A-Za-z0-9._@/:=,+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}
/** Render an argv array as a copy-pasteable display command (execution uses the argv array). */
export function displayCommand(argv) {
  return argv.map(q).join(" ");
}
function op(argv, extra = {}) {
  return { argv, command: displayCommand(argv), ...extra };
}

/** `npm stage download <id>` + local SHA-256 compare — the mandatory pre-approval inspection. */
export function inspectionInstructions({ stageId, tarballSha256, version, target }) {
  const releaseTarget = targetFor(target);
  assertToken("stageId", stageId);
  assertSha256(tarballSha256);
  assertVersion(version);
  // npm 11.15 does not implement `stage download --out`; it writes this deterministic filename.
  const out = `./${stageDownloadFilenameForTarget(releaseTarget, version, stageId)}`;
  const bare = String(tarballSha256).replace(/^sha256:/, "");
  return {
    title: "Inspect the staged tarball BEFORE approval",
    steps: [
      `npm stage download ${stageId}`,
      `shasum -a 256 ${out}`,
      `test "$(shasum -a 256 ${out} | awk '{print $1}')" = "${bare}" && echo MATCH || echo MISMATCH`,
    ],
    expected_sha256: `sha256:${bare}`,
    on_mismatch: "reject the stage; a mismatch means the staged bytes are not the retained candidate",
  };
}

/** `npm stage reject <id>` (+2FA). A rejected stage is spent; the next SemVer is prepared. */
export function rejectOperation({ stageId }) {
  return op(["npm", "stage", "reject", assertToken("stageId", stageId)], { requires_2fa: true });
}

/** `npm stage approve <id>` (+2FA) — only after a matching inspection. */
export function approveOperation({ stageId }) {
  return op(["npm", "stage", "approve", assertToken("stageId", stageId)], { requires_2fa: true });
}

/** Move a secondary dist-tag (e.g. float `next` to a prerelease candidate). */
export function secondaryTagOperation({ version, tag, target }) {
  const releaseTarget = targetFor(target);
  return op(["npm", "dist-tag", "add", `${releaseTarget.package.name}@${assertVersion(version)}`, assertToken("tag", tag)]);
}

/** Remove a stale secondary tag (e.g. drop `next` once stable makes it redundant). */
export function removeSecondaryTagOperation({ tag, target }) {
  const releaseTarget = targetFor(target);
  return op(["npm", "dist-tag", "rm", releaseTarget.package.name, assertToken("tag", tag)]);
}

/**
 * Post-approval failure recovery (§5): restore the failed track to the prior known-good version and
 * deprecate the failed version WITH the recovery command as the message. Returns argvs + display
 * commands.
 */
export function rollbackOperation({ failedVersion, priorVersion, track = "next", target, recoveryTarget = target }) {
  const releaseTarget = targetFor(target);
  const recovery = targetFor(recoveryTarget);
  assertVersion(failedVersion);
  assertVersion(priorVersion);
  assertToken("track", track);
  const recoveryCommand = `npm install --global ${recovery.package.name}@${priorVersion}`;
  const argvs = [
    ["npm", "dist-tag", "add", `${recovery.package.name}@${priorVersion}`, track],
    ["npm", "deprecate", `${releaseTarget.package.name}@${failedVersion}`, `superseded - install ${recovery.package.name}@${priorVersion} (${recoveryCommand})`],
  ];
  return { argvs, commands: argvs.map(displayCommand), recovery_command: recoveryCommand };
}

/**
 * Human-readable registry inspection commands. The strict integrity/signature/provenance/install
 * proof is performed by release-verify-registry.mjs in the separately dispatched finalizer.
 */
export function registryVerifyOperations({ version, target }) {
  const releaseTarget = targetFor(target);
  assertVersion(version);
  const coord = `${releaseTarget.package.name}@${version}`;
  const argvs = [
    ["npm", "view", coord, "dist.integrity", "dist.shasum", "--json"],
    ["npm", "view", coord, "--json"],
    ["npm", "pack", coord, "--json", "--ignore-scripts"],
  ];
  return {
    argvs,
    commands: argvs.map(displayCommand),
    workflow_proof: `node scripts/release-verify-registry.mjs --target ${releaseTarget.id} --version ${version} --manifest release-candidate/candidate.json`,
  };
}

/** Interactive dist-tag promotion after registry proof (§5 promoted). */
export function promoteOperation({ version, tag, target }) {
  const releaseTarget = targetFor(target);
  return op(["npm", "dist-tag", "add", `${releaseTarget.package.name}@${assertVersion(version)}`, assertToken("tag", tag)]);
}

/**
 * The promotion the reviewed tuple DECLARES for this target: `publication.npm_promote_tag`, the
 * same manifest field release-resolve-target.mjs hands the finalize workflow. The receipt is the
 * path a human follows when that workflow fails, so it must not restate the policy from another
 * value — the stage tag (`publication.npm_tag`) is what npm already holds and promoting to it is a
 * no-op. Returns null when the tuple declares no promotion, so the caller OMITS the operation
 * instead of telling the operator to move a dist-tag the reviewed policy leaves alone.
 */
export function promoteOperationForTarget({ version, target }) {
  const releaseTarget = targetFor(target);
  const tuple = resolveAllowedTupleByTarget(defaultReleaseManifest(), { target: releaseTarget.id });
  if (tuple.publication.npm_promote_tag === null) return null;
  return promoteOperation({ version, tag: tuple.publication.npm_promote_tag, target: releaseTarget.id });
}

/**
 * Immutable-release finalization (§5 final): publish the PREPARED GitHub draft (never create a new
 * one) after re-verifying its identity. Returns argvs + display commands.
 */
export function immutableReleaseOperations({ releaseId, tag, githubLatest }) {
  assertToken("releaseId", releaseId);
  assertToken("tag", tag);
  const makeLatest = assertBooleanish("githubLatest", githubLatest);
  const releasePath = `repos/{owner}/{repo}/releases/${releaseId}`;
  const argvs = [
    ["gh", "api", releasePath, "--jq", ".draft, .tag_name, .id"],
    ["gh", "api", "-X", "PATCH", releasePath, "-f", "draft=false", "-f", `make_latest=${makeLatest}`],
  ];
  return { argvs, commands: argvs.map(displayCommand), tag };
}
