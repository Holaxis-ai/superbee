import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseResolveTargetArgs, renderGithubOutput, resolveTargetFacts } from "./release-resolve-target.mjs";
import { loadReleaseTargets, normalizeReleaseTargets, resolveDeclaredTarget, targetFromPackageName, updatePolicyForTarget } from "./release-targets.mjs";

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
  assert.deepEqual(await resolveTargetFacts({ target: "successor-stable", tag: "v0.1.0" }), {
    target: "successor-stable",
    package: "superbee",
    version: "0.1.0",
    tag: "v0.1.0",
    policy_tag: "next",
    npm_promote_tag: "latest",
    github_latest: true,
    workflow_contract: "full",
  });
});

test("the functional successor floor is independently reviewed and remains at or below the successor tuple", async () => {
  const manifest = await loadReleaseTargets();
  assert.equal(manifest.functional_successor_floor, manifest.allowed_tuples["successor-stable"].version);

  const laterSuccessor = {
    ...manifest,
    allowed_tuples: {
      ...manifest.allowed_tuples,
      "successor-stable": { ...manifest.allowed_tuples["successor-stable"], version: "0.1.1", tag: "v0.1.1" },
    },
  };
  assert.equal(normalizeReleaseTargets(laterSuccessor).functional_successor_floor, manifest.functional_successor_floor);

  assert.throws(
    () => normalizeReleaseTargets({ ...manifest, functional_successor_floor: "0.1.1" }),
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
    assert.throws(
      () => resolveDeclaredTarget({ packageName, targets, context: "test target", fallbackTargetId: "bridge" }),
      /test target package name must be a string/,
      `fallback + ${JSON.stringify(packageName)}`,
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
    npm_promote_tag: null,
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
