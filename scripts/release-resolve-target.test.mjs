import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseResolveTargetArgs, renderGithubOutput, resolveTargetFacts } from "./release-resolve-target.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseResolveTargetArgs requires tag and defaults to the release manifest", () => {
  assert.deepEqual(parseResolveTargetArgs(["--target", "successor", "--tag", "v0.1.0-pre.11"]), {
    target: "successor",
    tag: "v0.1.0-pre.11",
    manifest: path.join(repoRoot, "release", "targets.json"),
    githubOutput: undefined,
    json: false,
  });
  assert.equal(parseResolveTargetArgs(["--tag", "v0.1.0-pre.10"]).target, undefined);
});

test("resolveTargetFacts returns the allowlisted tuple and policy tag", async () => {
  assert.deepEqual(await resolveTargetFacts({ target: "successor", tag: "v0.1.0-pre.11" }), {
    target: "successor",
    package: "superbee",
    version: "0.1.0-pre.11",
    tag: "v0.1.0-pre.11",
    policy_tag: "next",
  });
});

test("resolveTargetFacts rejects target/tag mismatches before workflows mutate", async () => {
  await assert.rejects(
    resolveTargetFacts({ target: "successor", tag: "v0.1.0-pre.10" }),
    /is not allowlisted/,
  );
});

test("resolveTargetFacts can infer the target from a unique allowlisted tag", async () => {
  assert.deepEqual(await resolveTargetFacts({ tag: "v0.1.0-pre.10" }), {
    target: "bridge",
    package: "@holaxis/aslite",
    version: "0.1.0-pre.10",
    tag: "v0.1.0-pre.10",
    policy_tag: "next",
  });
});

test("renderGithubOutput emits only primitive stable fields", () => {
  assert.equal(
    renderGithubOutput({
      target: "bridge",
      package: "@holaxis/aslite",
      version: "0.1.0-pre.10",
      tag: "v0.1.0-pre.10",
      policy_tag: "next",
    }),
    "target=bridge\npackage=@holaxis/aslite\nversion=0.1.0-pre.10\ntag=v0.1.0-pre.10\npolicy_tag=next\n",
  );
});
