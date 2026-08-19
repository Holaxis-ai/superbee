import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseResolveTargetArgs, renderGithubOutput, resolveTargetFacts } from "./release-resolve-target.mjs";
import { loadReleaseTargets, normalizeReleaseTargets, resolveDeclaredTarget, targetFromPackageName, updatePolicyForTarget } from "./release-targets.mjs";
import { compareStrictSemver } from "./strict-semver.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseResolveTargetArgs accepts a tag or target and defaults to the release manifest", () => {
  assert.deepEqual(parseResolveTargetArgs(["--target", "successor-stable", "--tag", "v0.1.0"]), {
    target: "successor-stable",
    tag: "v0.1.0",
    manifest: path.join(repoRoot, "release", "targets.json"),
    githubOutput: undefined,
    json: false,
  });
  assert.equal(parseResolveTargetArgs(["--tag", "v0.1.0-pre.11"]).target, undefined);
  assert.deepEqual(parseResolveTargetArgs(["--target", "rehearsal-reject"]), {
    target: "rehearsal-reject",
    tag: undefined,
    manifest: path.join(repoRoot, "release", "targets.json"),
    githubOutput: undefined,
    json: false,
  });
});

test("update policy is explicit per target and fails closed for identity-only rehearsals", async () => {
  const manifest = await loadReleaseTargets();
  assert.deepEqual(updatePolicyForTarget(manifest.targets.bridge), { enabled: true });
  assert.deepEqual(updatePolicyForTarget(manifest.targets["successor-stable"]), { enabled: true });
  assert.deepEqual(updatePolicyForTarget(manifest.targets["rehearsal-approve"]), { enabled: false });
  assert.deepEqual(updatePolicyForTarget(undefined), { enabled: false });
});

test("resolveTargetFacts returns the allowlisted tuple and policy tag", async () => {
  // Version and tag come FROM the manifest; the publication policy stays written out, because the
  // policy is what this test is about and a tuple's version/tag are deliberately mobile.
  const tuple = (await loadReleaseTargets()).allowed_tuples["successor-stable"];
  assert.deepEqual(await resolveTargetFacts({ target: "successor-stable", tag: tuple.tag }), {
    target: "successor-stable",
    package: "superbee",
    version: tuple.version,
    tag: tuple.tag,
    policy_tag: "next",
    npm_promote_tag: "latest",
    github_latest: true,
    workflow_contract: "full",
  });
});

test("the preview tuple may prerelease its planned stable but rejects an older release line", async () => {
  // Loading the committed manifest runs the owning normalizer, so reaching the fixtures below
  // already proves that the checked-in pair satisfies either accepted shape: a later preview or a
  // prerelease of the exact planned stable. Do not restate only one of those shapes here.
  const manifest = await loadReleaseTargets();
  const stableVersion = manifest.allowed_tuples["successor-stable"].version;
  const sameLinePreview = {
    ...manifest,
    allowed_tuples: {
      ...manifest.allowed_tuples,
      "successor-preview": {
        ...manifest.allowed_tuples["successor-preview"],
        version: `${stableVersion}-pre.3`,
        tag: `v${stableVersion}-pre.3`,
      },
    },
  };
  assert.equal(
    normalizeReleaseTargets(sameLinePreview).allowed_tuples["successor-preview"].version,
    `${stableVersion}-pre.3`,
  );

  const olderLinePreview = structuredClone(sameLinePreview);
  olderLinePreview.allowed_tuples["successor-preview"].version = "0.1.0-pre.999";
  olderLinePreview.allowed_tuples["successor-preview"].tag = "v0.1.0-pre.999";
  assert.throws(() => normalizeReleaseTargets(olderLinePreview), /must order ABOVE successor-stable/);

  const prereleaseStable = structuredClone(sameLinePreview);
  prereleaseStable.allowed_tuples["successor-stable"].version = "0.1.1-pre.1";
  prereleaseStable.allowed_tuples["successor-stable"].tag = "v0.1.1-pre.1";
  prereleaseStable.allowed_tuples["successor-preview"].version = "0.1.1-pre.2";
  prereleaseStable.allowed_tuples["successor-preview"].tag = "v0.1.1-pre.2";
  assert.throws(() => normalizeReleaseTargets(prereleaseStable), /successor-stable.*must be a stable version/);
});

test("the functional successor floor is independently reviewed and remains at or below the successor tuple", async () => {
  const manifest = await loadReleaseTargets();
  // At or BELOW, matching this test's name and the rule in normalizeReleaseTargets (which compares
  // `stableSuccessor.version >= floor`). This asserted strict EQUALITY, which was only incidentally
  // true: the floor records where the successor became functionally complete, and it does not move
  // just because a release number was skipped. Retargeting the tuple to 0.1.1 -- 0.1.0 being
  // permanently unreachable -- made the incidental equality fail while the actual rule still held.
  assert.ok(
    compareStrictSemver(manifest.functional_successor_floor, manifest.allowed_tuples["successor-stable"].version) <= 0,
    `floor ${manifest.functional_successor_floor} must be at or below successor ${manifest.allowed_tuples["successor-stable"].version}`,
  );

  const later = "0.9.0"; // strictly above any current tuple, so the assertions below stay meaningful
  const laterSuccessor = {
    ...manifest,
    allowed_tuples: {
      ...manifest.allowed_tuples,
      "successor-stable": { ...manifest.allowed_tuples["successor-stable"], version: later, tag: `v${later}` },
      // Keep the preview compatible with the moved stable so this fixture exercises the floor.
      "successor-preview": { ...manifest.allowed_tuples["successor-preview"], version: "0.9.1-pre.1", tag: "v0.9.1-pre.1" },
    },
  };
  assert.equal(normalizeReleaseTargets(laterSuccessor).functional_successor_floor, manifest.functional_successor_floor);

  assert.throws(
    () => normalizeReleaseTargets({ ...manifest, functional_successor_floor: later }),
    /must be at or above functional successor floor/,
  );
  assert.throws(
    () => normalizeReleaseTargets({ ...manifest, functional_successor_floor: undefined }),
    /invalid release version/,
  );
  for (const malformed of ["01.2.3", "1.02.3", "1.2.3-01", "1.2.3-alpha."]) {
    const successor = { ...manifest.allowed_tuples["successor-stable"], version: malformed, tag: `v${malformed}` };
    assert.throws(
      () =>
        normalizeReleaseTargets({
          ...manifest,
          functional_successor_floor: malformed,
          allowed_tuples: { ...manifest.allowed_tuples, "successor-stable": successor },
        }),
      /invalid release version/,
      malformed,
    );
  }
});

test("release tuples cannot consume burns and the checked-in CLI declares the successor tuple", async () => {
  const manifest = await loadReleaseTargets();
  const cli = JSON.parse(await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"));
  assert.deepEqual(
    { name: cli.name, version: cli.version },
    { name: manifest.allowed_tuples["successor-stable"].package, version: manifest.allowed_tuples["successor-stable"].version },
  );
  const burnedBridge = {
    ...manifest,
    allowed_tuples: {
      ...manifest.allowed_tuples,
      bridge: { ...manifest.allowed_tuples.bridge, version: "0.1.0-pre.10", tag: "v0.1.0-pre.10" },
    },
  };
  assert.throws(() => normalizeReleaseTargets(burnedBridge, { burnedVersions: ["0.1.0-pre.10"] }), /uses burned version/);
});

test("production npm and GitHub publication policies are exact target contracts", async () => {
  const manifest = await loadReleaseTargets();
  const drifted = structuredClone(manifest);
  delete drifted.allowed_tuples.bridge.publication.github_latest;
  assert.throws(() => normalizeReleaseTargets(drifted), /requires explicit publication policy/);
  const previewLatest = structuredClone(manifest);
  previewLatest.allowed_tuples["successor-preview"].publication.github_latest = "true";
  assert.throws(() => normalizeReleaseTargets(previewLatest), /invalid GitHub latest policy/);
});

const cutoverContractPath = path.join(repoRoot, "release", "cutover-contract.json");

test("the cutover roster and publication policy are approved by something that is not the manifest", async () => {
  const manifest = await loadReleaseTargets();
  const contract = JSON.parse(await readFile(cutoverContractPath, "utf8"));
  assert.deepEqual(Object.keys(contract.targets).sort(), Object.keys(manifest.targets).sort());
  for (const [id, entry] of Object.entries(contract.targets)) {
    assert.deepEqual(Object.keys(entry), ["policy_sha256"], `${id} approval carries a digest and nothing else`);
    assert.match(entry.policy_sha256, /^sha256:[0-9a-f]{64}$/, id);
  }

  const shadowed = structuredClone(manifest);
  shadowed.targets.shadow = { ...structuredClone(manifest.targets["successor-stable"]), id: "shadow" };
  shadowed.allowed_tuples.shadow = {
    id: "shadow",
    target: "shadow",
    package: "superbee",
    version: "9.9.9",
    tag: "v9.9.9",
    outcome: "publish",
    production: true,
    publication: { npm_tag: "next", npm_promote_tag: "latest", github_latest: true },
  };
  assert.throws(() => normalizeReleaseTargets(shadowed), /declares 2 GitHub latest releases \(shadow, successor-stable\)/);
  shadowed.allowed_tuples.shadow.publication = { npm_tag: "next", npm_promote_tag: null, github_latest: false };
  assert.throws(() => normalizeReleaseTargets(shadowed), /roster \(unapproved: shadow; unlisted: none\)/);

  const retired = structuredClone(manifest);
  delete retired.targets["successor-preview"];
  delete retired.allowed_tuples["successor-preview"];
  assert.throws(() => normalizeReleaseTargets(retired), /roster \(unapproved: none; unlisted: successor-preview\)/);

  for (const id of ["bridge", "successor-preview"]) {
    const flipped = structuredClone(manifest);
    flipped.allowed_tuples[id].publication.github_latest = true;
    assert.throws(() => normalizeReleaseTargets(flipped), /declares 2 GitHub latest releases/, id);
  }
  const demoted = structuredClone(manifest);
  demoted.allowed_tuples["successor-stable"].publication.github_latest = false;
  assert.throws(() => normalizeReleaseTargets(demoted), /successor-stable: approved sha256:/);
  const promoted = structuredClone(manifest);
  promoted.allowed_tuples["successor-preview"].publication.npm_promote_tag = "latest";
  assert.throws(() => normalizeReleaseTargets(promoted), /successor-preview: approved sha256:/);
  const rebranded = structuredClone(manifest);
  rebranded.targets.bridge.package = { name: "superbee", directory: ["superbee"] };
  rebranded.allowed_tuples.bridge.package = "superbee";
  assert.throws(() => normalizeReleaseTargets(rebranded), /bridge: approved sha256:/);
  const escalated = structuredClone(manifest);
  escalated.targets["rehearsal-reject"].workflow_contract = "full";
  assert.throws(() => normalizeReleaseTargets(escalated), /rehearsal-reject: approved sha256:/);
});

test("a publication policy the manifest grammar forbids is rejected before any approval is consulted", async () => {
  const manifest = await loadReleaseTargets();
  const rehearsalLatest = structuredClone(manifest);
  rehearsalLatest.allowed_tuples["rehearsal-approve"].publication.github_latest = true;
  assert.throws(() => normalizeReleaseTargets(rehearsalLatest), /non-publish release tuple rehearsal-approve must not claim the GitHub latest release/);
  const rehearsalPromote = structuredClone(manifest);
  rehearsalPromote.allowed_tuples["rehearsal-reject"].publication.npm_promote_tag = "latest";
  assert.throws(() => normalizeReleaseTargets(rehearsalPromote), /cannot promote a dist-tag for a version it never publishes/);
});

test("re-approving the cutover is a separate deliberate act that blesses exactly one target", async () => {
  const manifest = await loadReleaseTargets();
  const drifted = structuredClone(manifest);
  drifted.allowed_tuples["successor-preview"].publication.npm_promote_tag = "latest";

  let reported = "";
  try {
    normalizeReleaseTargets(drifted);
  } catch (error) {
    reported = error.message;
  }
  const declared = /successor-preview: approved sha256:[0-9a-f]{64}, declared (sha256:[0-9a-f]{64})/.exec(reported);
  assert.ok(declared, `drift must report the digest a reviewer has to approve: ${reported}`);
  assert.match(reported, /"npm_promote_tag":"latest"/);

  const reapproved = JSON.parse(await readFile(cutoverContractPath, "utf8"));
  reapproved.targets["successor-preview"] = { policy_sha256: declared[1] };
  assert.equal(
    normalizeReleaseTargets(drifted, { contract: reapproved }).allowed_tuples["successor-preview"].publication.npm_promote_tag,
    "latest",
  );
  assert.throws(() => normalizeReleaseTargets(manifest, { contract: reapproved }), /successor-preview: approved sha256:/);
});

test("manifest normalization fails closed on a missing or malformed cutover approval", async () => {
  const manifest = await loadReleaseTargets();
  const digest = `sha256:${"0".repeat(64)}`;
  const cases = [
    ["null", null],
    ["array", []],
    ["empty object", {}],
    ["no roster", { schema: "superbee.cutover-contract.v1" }],
    ["wrong schema", { schema: "superbee.release-targets.v1", targets: { bridge: { policy_sha256: digest } } }],
    ["empty roster", { schema: "superbee.cutover-contract.v1", targets: {} }],
    ["short digest", { schema: "superbee.cutover-contract.v1", targets: { bridge: { policy_sha256: "sha256:abc" } } }],
    ["bare digest", { schema: "superbee.cutover-contract.v1", targets: { bridge: digest.slice(7) } }],
    ["annotated entry", { schema: "superbee.cutover-contract.v1", targets: { bridge: { policy_sha256: digest, note: "approved" } } }],
    ["unsupported key", { schema: "superbee.cutover-contract.v1", targets: { bridge: { policy_sha256: digest } }, waived: true }],
  ];
  for (const [label, contract] of cases) {
    assert.throws(() => normalizeReleaseTargets(manifest, { contract }), /release\/cutover-contract\.json/, label);
  }
  await assert.rejects(
    loadReleaseTargets(path.join(repoRoot, "release", "targets.json"), { contractFile: path.join(repoRoot, "release", "no-such-approval.json") }),
    /ENOENT/,
  );
});

test("the cutover approval binds to the reviewed source tree, not to the manifest handed in", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-foreign-cutover-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(path.join(scratch, "scripts"), { recursive: true });
  await mkdir(path.join(scratch, "release"), { recursive: true });
  // Every first-party module release-targets.mjs imports must exist in the scratch tree, or the
  // foreign load fails on module resolution instead of on the approval this test is about.
  for (const relative of ["scripts/release-targets.mjs", "scripts/strict-semver.mjs", "scripts/canonical-json.mjs", "release/burned-versions.json"]) {
    await copyFile(path.join(repoRoot, relative), path.join(scratch, relative));
  }
  const foreignManifestPath = path.join(scratch, "release", "targets.json");
  const foreignBurnedPath = path.join(scratch, "release", "burned-versions.json");
  const doctored = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
  doctored.allowed_tuples["successor-preview"].publication.npm_promote_tag = "latest";
  await writeFile(foreignManifestPath, JSON.stringify(doctored, null, 2));

  // A second instance of the real module whose reviewed source tree is the scratch directory.
  const foreign = await import(pathToFileURL(path.join(scratch, "scripts", "release-targets.mjs")).href);

  // The synchronous authority consults the approval as well: with none in that tree, no manifest.
  assert.throws(() => foreign.defaultReleaseManifest(), /ENOENT/);
  assert.throws(() => foreign.defaultReleaseTargets(), /ENOENT/);

  let reported = "";
  try {
    normalizeReleaseTargets(doctored);
  } catch (error) {
    reported = error.message;
  }
  const declared = /successor-preview: approved sha256:[0-9a-f]{64}, declared (sha256:[0-9a-f]{64})/.exec(reported);
  assert.ok(declared, `drift must report the digest a reviewer has to approve: ${reported}`);

  const siblingApproval = JSON.parse(await readFile(cutoverContractPath, "utf8"));
  siblingApproval.targets["successor-preview"] = { policy_sha256: declared[1] };
  await writeFile(path.join(scratch, "release", "cutover-contract.json"), JSON.stringify(siblingApproval, null, 2));

  // That tree approves its own manifest, because there the approval is the reviewed source.
  assert.equal(
    foreign.defaultReleaseManifest().allowed_tuples["successor-preview"].publication.npm_promote_tag,
    "latest",
  );
  // Handed to this checkout, the same manifest is measured against this checkout's approval, and
  // the approval sitting next to it counts for nothing - a foreign manifest cannot approve itself.
  await assert.rejects(
    loadReleaseTargets(foreignManifestPath, { burnedFile: foreignBurnedPath, cliPackageFile: null }),
    /successor-preview: approved sha256:/,
  );
});

test("an explicit --manifest path still gets the burn ledger and checked-in CLI checks", async (t) => {
  // scripts/release-candidate.mjs passes createReleaseCandidate's --manifest straight through, so
  // this is the live shape: a manifest somewhere other than release/targets.json, loaded with no
  // other options. The reviewed ledger and CLI still apply; only an explicit argument opts out.
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-explicit-manifest-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const raw = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));

  const burnedLedger = JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8"));
  const stableVersion = raw.allowed_tuples["successor-stable"].version;
  const burnedVersion = burnedLedger.burned
    .map((entry) => entry.version)
    .find((version) => version.startsWith(`${stableVersion}-`));
  assert.ok(burnedVersion, `fixture requires a burned prerelease of ${stableVersion}`);
  // The burned version is a valid same-line preview of the planned stable, so only the burn ledger
  // rejects it. This keeps the burnedFile:null opt-out below reachable and proves the two guards are
  // independent.
  const burning = structuredClone(raw);
  burning.allowed_tuples["successor-preview"].version = burnedVersion;
  burning.allowed_tuples["successor-preview"].tag = `v${burnedVersion}`;
  const burningPath = path.join(scratch, "burning-targets.json");
  await writeFile(burningPath, JSON.stringify(burning, null, 2));
  await assert.rejects(loadReleaseTargets(burningPath), new RegExp(`uses burned version ${burnedVersion.replace(/\./g, "\\.")}`));

  const driftedCli = structuredClone(raw);
  driftedCli.allowed_tuples["successor-stable"].version = "9.9.9";
  driftedCli.allowed_tuples["successor-stable"].tag = "v9.9.9";
  driftedCli.functional_successor_floor = "9.9.9";
  // Keep the preview compatible with the moved stable so the checked-in CLI pin is the failing guard.
  driftedCli.allowed_tuples["successor-preview"].version = "9.9.10-pre.1";
  driftedCli.allowed_tuples["successor-preview"].tag = "v9.9.10-pre.1";
  const driftedCliPath = path.join(scratch, "drifted-cli-targets.json");
  await writeFile(driftedCliPath, JSON.stringify(driftedCli, null, 2));
  await assert.rejects(loadReleaseTargets(driftedCliPath), /packages\/cli\/package\.json must declare successor superbee@9\.9\.9/);

  // An unmodified manifest at a foreign path still loads, so the checks are binding, not blanket.
  const faithfulPath = path.join(scratch, "faithful-targets.json");
  await writeFile(faithfulPath, JSON.stringify(raw, null, 2));
  assert.equal((await loadReleaseTargets(faithfulPath)).allowed_tuples.bridge.version, raw.allowed_tuples.bridge.version);

  // Opting out stays possible, but only by saying so at the call site.
  assert.equal(
    (await loadReleaseTargets(burningPath, { burnedFile: null })).allowed_tuples["successor-preview"].version,
    burnedVersion,
  );
});

test("package-only compatibility lookup refuses the split Superbee coordinates", async () => {
  const manifest = await loadReleaseTargets();
  assert.equal(targetFromPackageName("@holaxis/aslite", manifest.targets), "bridge");
  assert.equal(targetFromPackageName("superbee", manifest.targets), null);
});

test("declared-target resolution fails closed for ambiguous or missing package-only identity", async () => {
  const manifest = await loadReleaseTargets();
  assert.equal(
    resolveDeclaredTarget({ packageName: "@holaxis/aslite", targets: manifest.targets, context: "test target" }).id,
    "bridge",
  );
  assert.throws(
    () => resolveDeclaredTarget({ packageName: "superbee", targets: manifest.targets, context: "test target" }),
    /ambiguous across targets successor-preview, successor-stable; explicit target required/,
  );
  assert.throws(
    () => resolveDeclaredTarget({ targets: manifest.targets, context: "test target" }),
    /requires an explicit target/,
  );
});

test("declared-target resolution rejects every non-string release identity", async () => {
  const manifest = await loadReleaseTargets();
  const targets = manifest.targets;
  for (const packageName of [null, 12345, { name: "superbee" }, ["superbee"]]) {
    assert.throws(
      () => resolveDeclaredTarget({ targetId: "bridge", packageName, targets, context: "test target" }),
      /test target package name must be a string/,
      `targetId + ${JSON.stringify(packageName)}`,
    );
    assert.throws(
      () => resolveDeclaredTarget({ packageName, targets, context: "test target" }),
      /test target package name must be a string/,
      `package-only ${JSON.stringify(packageName)}`,
    );
  }
  for (const targetId of [null, 12345, { id: "bridge" }, ["bridge"]]) {
    assert.throws(
      () => resolveDeclaredTarget({ targetId, packageName: "@holaxis/aslite", targets, context: "test target" }),
      /test target target id must be a string/,
      `${JSON.stringify(targetId)} + packageName`,
    );
  }
});

test("no extra field can stand in for an absent release target", async () => {
  const manifest = await loadReleaseTargets();
  const targets = manifest.targets;
  // Each of these is a plausible way to reintroduce a silent default into the shared primitive.
  // Absent identity must stay unresolvable no matter what else the caller passes.
  const redirects = [
    { fallbackTargetId: "bridge" },
    { fallbackTarget: "bridge" },
    { defaultTargetId: "bridge" },
    { target: "bridge" },
    { targetId: undefined, packageName: undefined },
  ];
  for (const redirect of redirects) {
    assert.throws(
      () => resolveDeclaredTarget({ targets, context: "test target", ...redirect }),
      /test target requires an explicit target/,
      JSON.stringify(redirect),
    );
    assert.throws(
      () => resolveDeclaredTarget({ targets, context: "test target", workflowContract: "full", ...redirect }),
      /test target requires an explicit target/,
      `${JSON.stringify(redirect)} + workflowContract`,
    );
  }
});

test("the normalized manifest requires target ids and tuple ids to stay aligned", async () => {
  const manifest = await loadReleaseTargets();
  const omittedTarget = structuredClone(manifest);
  delete omittedTarget.targets["successor-preview"];
  assert.throws(() => normalizeReleaseTargets(omittedTarget), /references missing target successor-preview/);
  const omittedTuple = structuredClone(manifest);
  delete omittedTuple.allowed_tuples["successor-preview"];
  assert.throws(() => normalizeReleaseTargets(omittedTuple), /target ids and allowlisted tuple ids must match exactly/);
  const extraTarget = structuredClone(manifest);
  extraTarget.targets.experimental = structuredClone(manifest.targets.bridge);
  extraTarget.targets.experimental.package.name = "superbee-experimental";
  extraTarget.targets.experimental.package.directory = ["superbee-experimental"];
  extraTarget.targets.experimental.tarball_basename = "superbee-experimental";
  extraTarget.targets.experimental.bins = { "superbee-experimental": "dist/superbee.mjs" };
  extraTarget.targets.experimental.expected_commands = ["superbee-experimental"];
  extraTarget.targets.experimental.preferred_command = "superbee-experimental";
  extraTarget.targets.experimental.allow_production = false;
  assert.throws(() => normalizeReleaseTargets(extraTarget), /target ids and allowlisted tuple ids must match exactly/);
  const retargetedTuple = structuredClone(manifest);
  retargetedTuple.allowed_tuples.bridge.target = "successor-stable";
  assert.throws(() => normalizeReleaseTargets(retargetedTuple), /release tuple bridge must target bridge/);
});

test("resolveTargetFacts rejects target/tag mismatches before workflows mutate", async () => {
  await assert.rejects(
    resolveTargetFacts({ target: "successor-stable", tag: "v0.1.0-pre.11" }),
    /is not allowlisted/,
  );
});

test("resolveTargetFacts can infer the target from a unique allowlisted tag", async () => {
  assert.deepEqual(await resolveTargetFacts({ tag: "v0.1.0-pre.11" }), {
    target: "bridge",
    package: "@holaxis/aslite",
    version: "0.1.0-pre.11",
    tag: "v0.1.0-pre.11",
    policy_tag: "next",
    npm_promote_tag: "latest",
    github_latest: false,
    workflow_contract: "full",
  });
});

test("resolveTargetFacts resolves a unique identity-only rehearsal target without duplicating its tag in a workflow", async () => {
  assert.deepEqual(await resolveTargetFacts({ target: "rehearsal-reject" }), {
    target: "rehearsal-reject",
    package: "superbee-release-rehearsal",
    version: "0.0.0-rename-reject.20260812",
    tag: "v0.0.0-rename-reject.20260812",
    policy_tag: null,
    npm_promote_tag: null,
    github_latest: false,
    workflow_contract: "identity-only",
  });
});

test("renderGithubOutput emits only primitive stable fields", () => {
  assert.equal(
    renderGithubOutput({
      target: "bridge",
      package: "@holaxis/aslite",
      version: "0.1.0-pre.11",
      tag: "v0.1.0-pre.11",
      policy_tag: "next",
      npm_promote_tag: null,
      github_latest: false,
      workflow_contract: "full",
    }),
    "target=bridge\npackage=@holaxis/aslite\nversion=0.1.0-pre.11\ntag=v0.1.0-pre.11\npolicy_tag=next\nnpm_promote_tag=\ngithub_latest=false\nworkflow_contract=full\n",
  );
});

// Stated here rather than imported from the renderer, so this test is an independent claim about
// the workflow contract and fails on the rendering when the renderer stops enforcing it.
const EXPECTED_GITHUB_OUTPUT_FIELDS = Object.freeze({
  target: "required",
  package: "required",
  version: "required",
  tag: "required",
  policy_tag: "nullable",
  npm_promote_tag: "nullable",
  github_latest: "required",
  workflow_contract: "required",
});

test("renderGithubOutput refuses to render a fact set that is not the resolved target contract", async () => {
  const facts = await resolveTargetFacts({
    target: "successor-stable",
    tag: (await loadReleaseTargets()).allowed_tuples["successor-stable"].tag,
  });
  assert.deepEqual(Object.keys(facts).sort(), Object.keys(EXPECTED_GITHUB_OUTPUT_FIELDS).sort());

  // The finding's own scenario first: a dropped npm_promote_tag used to render `npm_promote_tag=`,
  // which finalize's `if [ -n "$NPM_PROMOTE_TAG" ]` reads as "policy says do not promote".
  const withoutPromoteTag = { ...facts };
  delete withoutPromoteTag.npm_promote_tag;
  assert.throws(() => renderGithubOutput(withoutPromoteTag), /missing: npm_promote_tag/);

  for (const key of Object.keys(EXPECTED_GITHUB_OUTPUT_FIELDS)) {
    const dropped = { ...facts };
    delete dropped[key];
    assert.throws(() => renderGithubOutput(dropped), new RegExp(`missing: ${key}`), `dropped ${key}`);
    assert.throws(() => renderGithubOutput({ ...facts, [key]: undefined }), new RegExp(`github output ${key} is missing`), `undefined ${key}`);
  }

  const renamed = { ...facts, npm_promotion_tag: facts.npm_promote_tag };
  delete renamed.npm_promote_tag;
  assert.throws(() => renderGithubOutput(renamed), /missing: npm_promote_tag; unknown: npm_promotion_tag/);

  for (const [key, kind] of Object.entries(EXPECTED_GITHUB_OUTPUT_FIELDS)) {
    if (kind === "nullable") continue;
    assert.throws(() => renderGithubOutput({ ...facts, [key]: null }), new RegExp(`github output ${key} must not be null`), `null ${key}`);
    assert.throws(() => renderGithubOutput({ ...facts, [key]: "" }), new RegExp(`github output ${key} must not be empty`), `empty ${key}`);
  }
  assert.throws(() => renderGithubOutput({ ...facts, tag: "v0.1.0\nnpm_promote_tag=latest" }), /github output tag must be a single line/);
  assert.throws(() => renderGithubOutput(undefined), /requires resolved target facts/);
});

test("renderGithubOutput emits empty strings for nullable publication fields", () => {
  assert.equal(
    renderGithubOutput({
      target: "rehearsal-reject",
      package: "superbee-release-rehearsal",
      version: "0.0.0-rename-reject.20260812",
      tag: "v0.0.0-rename-reject.20260812",
      policy_tag: null,
      npm_promote_tag: null,
      github_latest: false,
      workflow_contract: "identity-only",
    }),
    "target=rehearsal-reject\npackage=superbee-release-rehearsal\nversion=0.0.0-rename-reject.20260812\ntag=v0.0.0-rename-reject.20260812\npolicy_tag=\nnpm_promote_tag=\ngithub_latest=false\nworkflow_contract=identity-only\n",
  );
});
