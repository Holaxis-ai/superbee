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
import { assertStrictSemver, parseStrictSemver } from "./strict-semver.mjs";

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
    context: "release operation",
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

/**
 * Interactive dist-tag promotion after registry proof (§5 promoted). npm 11.15 trusted publishing
 * is publish-scoped — `npm dist-tag add` performs no OIDC token exchange — so this is an OPERATOR
 * action with 2FA, like `npm stage approve`, never something a workflow can run for them.
 */
export function promoteOperation({ version, tag, target }) {
  const releaseTarget = targetFor(target);
  return op(
    ["npm", "dist-tag", "add", `${releaseTarget.package.name}@${assertVersion(version)}`, assertToken("tag", tag)],
    { requires_2fa: true },
  );
}

/**
 * The promotion the reviewed tuple DECLARES for this target: `publication.npm_promote_tag`, the
 * same manifest field every other consumer of the publication policy reads. Promotion is performed
 * by a human, so this command is the ONLY instruction they get for it and must not be restated
 * from another value — the stage tag (`publication.npm_tag`) is what npm already holds, and
 * promoting to it is a no-op that leaves the declared end state unreached. Returns null when the
 * tuple declares no promotion (bridge and both rehearsal tuples), so the caller OMITS the
 * operation rather than emitting an empty or no-op command.
 */
export function promoteOperationForTarget({ version, target }) {
  const releaseTarget = targetFor(target);
  const tuple = resolveAllowedTupleByTarget(defaultReleaseManifest(), { target: releaseTarget.id });
  if (tuple.publication.npm_promote_tag === null) return null;
  return promoteOperation({ version, tag: tuple.publication.npm_promote_tag, target: releaseTarget.id });
}

/**
 * Strict SemVer is the only authority for GitHub's prerelease bit. Build metadata never changes
 * the tier; only a syntactically valid prerelease component does.
 */
export function githubPrereleaseForVersion(version) {
  const parsed = parseStrictSemver(assertVersion(version));
  return parsed.prerelease !== null;
}

/**
 * Immutable-release finalization (§5 final): publish the PREPARED GitHub draft by its numeric ID.
 * The caller supplies only chain-proven identity. Tag and publication booleans are resolved from
 * one normalized manifest snapshot, so no dispatch value can restate or override policy.
 */
export function immutableReleaseOperations(input) {
  const allowed = ["releaseId", "sourceCommit", "target", "version"];
  const supplied = Object.keys(input ?? {}).sort();
  if (JSON.stringify(supplied) !== JSON.stringify(allowed)) {
    throw new Error(`immutable-release accepts exactly ${allowed.join(", ")}`);
  }
  const { releaseId, sourceCommit, target, version } = input;
  if (typeof releaseId !== "string" || !/^[1-9][0-9]*$/.test(releaseId)) {
    throw new Error(`invalid releaseId (must be a positive decimal integer): ${JSON.stringify(releaseId)}`);
  }
  if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`invalid sourceCommit (must be an exact lowercase 40-hex commit): ${JSON.stringify(sourceCommit)}`);
  }
  const manifest = defaultReleaseManifest();
  const releaseTarget = resolveDeclaredTarget({
    targetId: target,
    targets: manifest.targets,
    context: "immutable release operation",
    workflowContract: "full",
  });
  const tuple = resolveAllowedTupleByTarget(manifest, { target: releaseTarget.id });
  const suppliedVersion = assertVersion(version);
  if (suppliedVersion !== tuple.version) {
    throw new Error(`immutable release version ${suppliedVersion} != manifest tuple ${tuple.version} for ${releaseTarget.id}`);
  }
  const prerelease = githubPrereleaseForVersion(tuple.version);
  const makeLatest = tuple.publication.github_latest;
  const releasePath = `repos/{owner}/{repo}/releases/${releaseId}`;
  const argvs = [
    [
      "gh", "api", "-X", "PATCH", releasePath,
      "-f", `tag_name=${tuple.tag}`,
      "-f", `target_commitish=${sourceCommit}`,
      "-F", "draft=false",
      "-F", `prerelease=${prerelease}`,
      "-f", `make_latest=${makeLatest}`,
    ],
  ];
  return { argvs, commands: argvs.map(displayCommand), tag: tuple.tag };
}
