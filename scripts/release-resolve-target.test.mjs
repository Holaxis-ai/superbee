import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseResolveTargetArgs, renderGithubOutput, resolveTargetFacts } from "./release-resolve-target.mjs";
import { loadReleaseTargets, normalizeReleaseTargets, updatePolicyForTarget } from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseResolveTargetArgs accepts a tag or target and defaults to the release manifest", () => {
  assert.deepEqual(parseResolveTargetArgs(["--target", "successor", "--tag", "v0.1.0-pre.12"]), {
    target: "successor",
    tag: "v0.1.0-pre.12",
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
  assert.deepEqual(updatePolicyForTarget(manifest.targets.successor), { enabled: true });
  assert.deepEqual(updatePolicyForTarget(manifest.targets["rehearsal-approve"]), { enabled: false });
  assert.deepEqual(updatePolicyForTarget(undefined), { enabled: false });
});

test("resolveTargetFacts returns the allowlisted tuple and policy tag", async () => {
  assert.deepEqual(await resolveTargetFacts({ target: "successor", tag: "v0.1.0-pre.12" }), {
    target: "successor",
    package: "superbee",
    version: "0.1.0-pre.12",
    tag: "v0.1.0-pre.12",
    policy_tag: "next",
    workflow_contract: "full",
  });
});

test("the functional successor floor is independently reviewed and remains at or below the successor tuple", async () => {
  const manifest = await loadReleaseTargets();
  assert.equal(manifest.functional_successor_floor, manifest.allowed_tuples.successor.version);

  const laterSuccessor = {
    ...manifest,
    allowed_tuples: {
      ...manifest.allowed_tuples,
      successor: { ...manifest.allowed_tuples.successor, version: "0.1.0-pre.12", tag: "v0.1.0-pre.12" },
    },
  };
  assert.equal(normalizeReleaseTargets(laterSuccessor).functional_successor_floor, manifest.functional_successor_floor);

  assert.throws(
    () => normalizeReleaseTargets({ ...manifest, functional_successor_floor: "0.1.0-pre.13" }),
    /must be at or above functional successor floor/,
  );
  assert.throws(
    () => normalizeReleaseTargets({ ...manifest, functional_successor_floor: undefined }),
    /invalid release version/,
  );
  for (const malformed of ["01.2.3", "1.02.3", "1.2.3-01", "1.2.3-alpha."]) {
    const successor = { ...manifest.allowed_tuples.successor, version: malformed, tag: `v${malformed}` };
    assert.throws(
      () =>
        normalizeReleaseTargets({
          ...manifest,
          functional_successor_floor: malformed,
          allowed_tuples: { ...manifest.allowed_tuples, successor },
        }),
      /invalid release version/,
      malformed,
    );
  }
});

test("resolveTargetFacts rejects target/tag mismatches before workflows mutate", async () => {
  await assert.rejects(
    resolveTargetFacts({ target: "successor", tag: "v0.1.0-pre.11" }),
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
    workflow_contract: "full",
  });
});

test("resolveTargetFacts resolves a unique identity-only rehearsal target without duplicating its tag in a workflow", async () => {
  assert.deepEqual(await resolveTargetFacts({ target: "rehearsal-reject" }), {
    target: "rehearsal-reject",
    package: "superbee-release-rehearsal",
    version: "0.0.0-rename-reject.20260812",
    tag: "v0.0.0-rename-reject.20260812",
    policy_tag: "next",
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
      workflow_contract: "full",
    }),
    "target=bridge\npackage=@holaxis/aslite\nversion=0.1.0-pre.11\ntag=v0.1.0-pre.11\npolicy_tag=next\nworkflow_contract=full\n",
  );
});
