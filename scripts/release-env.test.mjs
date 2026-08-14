import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_RELEASE_LIVE_ENABLED,
  LEGACY_RELEASE_MANIFEST,
  LEGACY_RELEASE_TARBALL,
  requireLiveReleaseEnabled,
  resolveCompatibleReleaseEnv,
  resolveRetainedReleaseArtifacts,
  SUPERBEE_RELEASE_LIVE_ENABLED,
  SUPERBEE_RELEASE_MANIFEST,
  SUPERBEE_RELEASE_TARBALL,
} from "./release-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release settings prefer the canonical Superbee name while accepting an equal legacy value", () => {
  for (const env of [
    { [SUPERBEE_RELEASE_LIVE_ENABLED]: "true" },
    { [LEGACY_RELEASE_LIVE_ENABLED]: "true" },
    { [SUPERBEE_RELEASE_LIVE_ENABLED]: " true ", [LEGACY_RELEASE_LIVE_ENABLED]: "true" },
  ]) {
    assert.equal(resolveCompatibleReleaseEnv({
      canonicalName: SUPERBEE_RELEASE_LIVE_ENABLED,
      legacyName: LEGACY_RELEASE_LIVE_ENABLED,
      env,
    }), "true");
    assert.doesNotThrow(() => requireLiveReleaseEnabled(env));
  }
});

test("release settings fail closed on absence, non-true enablement, or an old/new conflict", () => {
  assert.equal(resolveCompatibleReleaseEnv({
    canonicalName: SUPERBEE_RELEASE_LIVE_ENABLED,
    legacyName: LEGACY_RELEASE_LIVE_ENABLED,
    env: {},
  }), undefined);
  assert.throws(() => requireLiveReleaseEnabled({}), /SUPERBEE_RELEASE_LIVE_ENABLED=true/);
  assert.throws(() => requireLiveReleaseEnabled({ [SUPERBEE_RELEASE_LIVE_ENABLED]: "false" }), /not explicitly live-enabled/);
  assert.throws(
    () => requireLiveReleaseEnabled({
      [SUPERBEE_RELEASE_LIVE_ENABLED]: "true",
      [LEGACY_RELEASE_LIVE_ENABLED]: "false",
    }),
    /SUPERBEE_RELEASE_LIVE_ENABLED and ASLITE_RELEASE_LIVE_ENABLED differ/,
  );
});

test("retained artifact inputs accept either name and reject conflicting paths without disclosing values", () => {
  assert.deepEqual(resolveRetainedReleaseArtifacts({
    [SUPERBEE_RELEASE_TARBALL]: "candidate.tgz",
    [LEGACY_RELEASE_MANIFEST]: "candidate.json",
  }), { tarball: "candidate.tgz", manifest: "candidate.json" });

  const canonical = "/private/canonical.tgz";
  const legacy = "/private/legacy.tgz";
  assert.throws(
    () => resolveRetainedReleaseArtifacts({
      [SUPERBEE_RELEASE_TARBALL]: canonical,
      [LEGACY_RELEASE_TARBALL]: legacy,
    }),
    (error) => {
      assert.match(error.message, /SUPERBEE_RELEASE_TARBALL and ASLITE_RELEASE_TARBALL differ/);
      assert.doesNotMatch(error.message, new RegExp(`${canonical}|${legacy}`));
      return true;
    },
  );
});

test("prepublish guard teaches canonical retained inputs and fails before verification on conflicts", () => {
  const script = path.join(repoRoot, "scripts", "prepublish-guard.mjs");
  const baseEnv = { ...process.env };
  for (const name of [
    SUPERBEE_RELEASE_TARBALL,
    LEGACY_RELEASE_TARBALL,
    SUPERBEE_RELEASE_MANIFEST,
    LEGACY_RELEASE_MANIFEST,
  ]) delete baseEnv[name];

  const missing = spawnSync(process.execPath, [script], { cwd: repoRoot, env: baseEnv, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /SUPERBEE_RELEASE_TARBALL/);
  assert.doesNotMatch(missing.stderr, /@holaxis\/aslite/);

  const conflict = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: {
      ...baseEnv,
      [SUPERBEE_RELEASE_TARBALL]: "/private/canonical.tgz",
      [LEGACY_RELEASE_TARBALL]: "/private/legacy.tgz",
    },
    encoding: "utf8",
  });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /SUPERBEE_RELEASE_TARBALL and ASLITE_RELEASE_TARBALL differ/);
  assert.doesNotMatch(conflict.stderr, /canonical\.tgz|legacy\.tgz/);
});
