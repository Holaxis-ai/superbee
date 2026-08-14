import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const SUPERBEE_RELEASE_LIVE_ENABLED = "SUPERBEE_RELEASE_LIVE_ENABLED";
export const LEGACY_RELEASE_LIVE_ENABLED = "ASLITE_RELEASE_LIVE_ENABLED";
export const SUPERBEE_RELEASE_TARBALL = "SUPERBEE_RELEASE_TARBALL";
export const LEGACY_RELEASE_TARBALL = "ASLITE_RELEASE_TARBALL";
export const SUPERBEE_RELEASE_MANIFEST = "SUPERBEE_RELEASE_MANIFEST";
export const LEGACY_RELEASE_MANIFEST = "ASLITE_RELEASE_MANIFEST";

function present(value) {
  return value === undefined || value === "" ? undefined : value;
}

export function resolveCompatibleReleaseEnv({ canonicalName, legacyName, env = process.env }) {
  const canonical = present(env[canonicalName]);
  const legacy = present(env[legacyName]);
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new Error(`conflicting release settings: ${canonicalName} and ${legacyName} differ`);
  }
  return canonical ?? legacy;
}

export function requireLiveReleaseEnabled(env = process.env) {
  const value = resolveCompatibleReleaseEnv({
    canonicalName: SUPERBEE_RELEASE_LIVE_ENABLED,
    legacyName: LEGACY_RELEASE_LIVE_ENABLED,
    env,
  });
  if (value !== "true") {
    throw new Error(`release environment is not explicitly live-enabled with ${SUPERBEE_RELEASE_LIVE_ENABLED}=true`);
  }
}

export function resolveRetainedReleaseArtifacts(env = process.env) {
  return {
    tarball: resolveCompatibleReleaseEnv({
      canonicalName: SUPERBEE_RELEASE_TARBALL,
      legacyName: LEGACY_RELEASE_TARBALL,
      env,
    }),
    manifest: resolveCompatibleReleaseEnv({
      canonicalName: SUPERBEE_RELEASE_MANIFEST,
      legacyName: LEGACY_RELEASE_MANIFEST,
      env,
    }),
  };
}

function main(argv) {
  if (argv.length !== 1 || argv[0] !== "require-live") {
    throw new Error("usage: release-env.mjs require-live");
  }
  requireLiveReleaseEnabled();
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
