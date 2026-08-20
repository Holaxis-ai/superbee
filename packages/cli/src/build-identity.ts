// One authority for the identity of the CLI bytes that are actually running.
//
// Build facts are baked into every bundle by scripts/build-bundle.mjs. Runtime facts are derived
// locally and read-only: executable path, launch evidence, an adjacent package.json drift signal,
// and the SHA-256 of the executing file. Source-run tests have no baked constant, so they use the
// package manifest only as a development fallback. A malformed baked constant fails closed instead
// of silently promoting an adjacent manifest to authority.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliInvocation,
  currentExecutableRealPath,
  managedBinNameOnPath,
  PACKAGE_NAME,
} from "./invocation.js";

declare const __SUPERBEE_BUILD_IDENTITY__: unknown;

export const BUILD_IDENTITY_SCHEMA = "superbee.build-identity.v1" as const;
export const BARE_VERSION_FLAGS = ["--version", "-v", "-V"] as const;
export const ARTIFACT_CHANNELS = [
  "npm-package",
  "local-dev",
  "unknown",
] as const;
export type ArtifactChannel = (typeof ARTIFACT_CHANNELS)[number];
export type LaunchMode = "path" | "direct" | "npx-inferred" | "source" | "unknown";
export type LaunchConfidence = "certain" | "inferred" | "unknown";

export function isBareVersionFlag(value: string | undefined): boolean {
  return BARE_VERSION_FLAGS.some((flag) => flag === value);
}

export interface CompatibilityContracts {
  skill: number | null;
  hook: number | null;
  mcp: number | null;
}

export interface StaticBuildIdentity {
  schema: typeof BUILD_IDENTITY_SCHEMA;
  package: { name: string; version: string };
  source: { commit: string | null; dirty: boolean | null };
  artifact: { channel: ArtifactChannel };
  compatibility_contracts: CompatibilityContracts;
}

export interface BuildIdentityEnvelope {
  identity: {
    schema: typeof BUILD_IDENTITY_SCHEMA;
    package: { name: string; version: string };
    source: { commit: string | null; dirty: boolean | null };
    artifact: { channel: ArtifactChannel; sha256: string | null };
    runtime: {
      executable_path: string | null;
      invocation: string;
      launch_mode: LaunchMode;
      launch_confidence: LaunchConfidence;
    };
    compatibility_contracts: CompatibilityContracts;
  };
  drift: { adjacent_package_version: string | null; version_mismatch: boolean };
}

function isNullableContract(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

function isNullableCommit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[a-f0-9]{40}$/.test(value));
}

function isPackageName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(value)
  );
}

/** Validate the untrusted compile-time literal before it becomes product identity. */
export function parseBakedBuildIdentity(value: unknown): StaticBuildIdentity | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const pkg = candidate.package;
  const source = candidate.source;
  const artifact = candidate.artifact;
  const contracts = candidate.compatibility_contracts;
  if (candidate.schema !== BUILD_IDENTITY_SCHEMA) return null;
  if (pkg === null || typeof pkg !== "object") return null;
  if (source === null || typeof source !== "object") return null;
  if (artifact === null || typeof artifact !== "object") return null;
  if (contracts === null || typeof contracts !== "object") return null;
  const p = pkg as Record<string, unknown>;
  const s = source as Record<string, unknown>;
  const a = artifact as Record<string, unknown>;
  const c = contracts as Record<string, unknown>;
  if (!isPackageName(p.name) || typeof p.version !== "string" || p.version.length === 0) return null;
  if (!isNullableCommit(s.commit) || !(s.dirty === null || typeof s.dirty === "boolean")) return null;
  if (!ARTIFACT_CHANNELS.includes(a.channel as ArtifactChannel) || a.channel === "unknown") return null;
  if (!isNullableContract(c.skill) || !isNullableContract(c.hook) || !isNullableContract(c.mcp)) return null;
  return {
    schema: BUILD_IDENTITY_SCHEMA,
    package: { name: p.name, version: p.version },
    source: { commit: s.commit, dirty: s.dirty },
    artifact: { channel: a.channel as ArtifactChannel },
    compatibility_contracts: { skill: c.skill, hook: c.hook, mcp: c.mcp },
  };
}

function unknownBuildIdentity(): StaticBuildIdentity {
  return {
    schema: BUILD_IDENTITY_SCHEMA,
    package: { name: PACKAGE_NAME, version: "unknown" },
    source: { commit: null, dirty: null },
    artifact: { channel: "unknown" },
    compatibility_contracts: { skill: null, hook: null, mcp: null },
  };
}

function freezeBuildIdentity(identity: StaticBuildIdentity): StaticBuildIdentity {
  Object.freeze(identity.package);
  Object.freeze(identity.source);
  Object.freeze(identity.artifact);
  Object.freeze(identity.compatibility_contracts);
  return Object.freeze(identity);
}

/** Fail-closed projection used when a bundle contains an invalid identity literal. */
export function resolveBakedBuildIdentity(value: unknown): StaticBuildIdentity {
  return freezeBuildIdentity(parseBakedBuildIdentity(value) ?? unknownBuildIdentity());
}

function sourcePackageIdentity(): { name: string; version: string } {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const manifest = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      isPackageName(manifest.name) &&
      typeof manifest.version === "string" &&
      manifest.version.length > 0
    ) {
      return { name: manifest.name, version: manifest.version };
    }
  } catch {
    // Fall through to the explicit fail-closed development identity.
  }
  return { name: PACKAGE_NAME, version: "unknown" };
}

function bakedConstant(): { present: boolean; value: unknown } {
  if (typeof __SUPERBEE_BUILD_IDENTITY__ === "undefined") return { present: false, value: undefined };
  return { present: true, value: __SUPERBEE_BUILD_IDENTITY__ };
}

let staticIdentityCache: StaticBuildIdentity | undefined;

/** Immutable facts baked into this bundle (or the explicit local-dev source fallback). */
export function staticBuildIdentity(): StaticBuildIdentity {
  if (staticIdentityCache) return staticIdentityCache;
  const baked = bakedConstant();
  if (baked.present) {
    staticIdentityCache = resolveBakedBuildIdentity(baked.value);
    return staticIdentityCache;
  }
  staticIdentityCache = freezeBuildIdentity({
    schema: BUILD_IDENTITY_SCHEMA,
    package: sourcePackageIdentity(),
    source: { commit: null, dirty: null },
    artifact: { channel: "local-dev" },
    compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
  });
  return staticIdentityCache;
}

/** The one version authority used by aliases, commands, installers, and protocol handshakes. */
export function cliVersion(): string {
  return staticBuildIdentity().package.version;
}

const shaCache = new Map<string, string>();

function executableSha256(executablePath: string | null): string | null {
  if (executablePath === null) return null;
  const cached = shaCache.get(executablePath);
  if (cached) return cached;
  try {
    const digest = `sha256:${createHash("sha256").update(readFileSync(executablePath)).digest("hex")}`;
    shaCache.set(executablePath, digest);
    return digest;
  } catch {
    return null;
  }
}

function adjacentPackageVersion(executablePath: string | null): string | null {
  if (executablePath === null) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(executablePath)), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

function sameRealPath(left: string | undefined, right: string | null): boolean {
  if (!left || right === null) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export interface RuntimeIdentityDeps {
  executablePath: () => string | undefined;
  invocation: () => string;
  managedBin: () => string | undefined;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

function launchEvidence(
  executablePath: string | null,
  deps: RuntimeIdentityDeps,
): { mode: LaunchMode; confidence: LaunchConfidence } {
  const npmExec = deps.env.npm_command === "exec" || deps.env.npm_lifecycle_event === "npx";
  const npxCachePath = executablePath?.includes("/_npx/") || executablePath?.includes("\\_npx\\");
  // A cache-resident executable is concrete npx evidence. Ambient npm lifecycle variables are
  // only a fallback: they can leak into nested processes and never outrank an executable that is
  // demonstrably on PATH or was launched directly.
  if (npxCachePath) return { mode: "npx-inferred", confidence: "inferred" };
  if (deps.managedBin()) return { mode: "path", confidence: "certain" };
  if (sameRealPath(deps.argv[1], executablePath)) return { mode: "direct", confidence: "certain" };
  if (npmExec) return { mode: "npx-inferred", confidence: "inferred" };
  // File suffix/layout is suggestive only. It never outranks concrete PATH/direct evidence and can
  // never establish certainty: a bundled .mjs can be copied beneath a directory named `src`.
  if (
    executablePath?.endsWith(".ts") ||
    executablePath?.includes("/src/") ||
    executablePath?.includes("\\src\\")
  ) {
    return { mode: "source", confidence: "inferred" };
  }
  return { mode: "unknown", confidence: "unknown" };
}

/** Complete local, offline identity envelope. No registry/network access occurs here. */
export function buildIdentityEnvelope(deps: Partial<RuntimeIdentityDeps> = {}): BuildIdentityEnvelope {
  const resolvedDeps: RuntimeIdentityDeps = {
    executablePath: deps.executablePath ?? currentExecutableRealPath,
    invocation: deps.invocation ?? cliInvocation,
    managedBin: deps.managedBin ?? managedBinNameOnPath,
    argv: deps.argv ?? process.argv,
    env: deps.env ?? process.env,
  };
  const build = staticBuildIdentity();
  const executablePath = resolvedDeps.executablePath() ?? null;
  const adjacent = adjacentPackageVersion(executablePath);
  const launch = launchEvidence(executablePath, resolvedDeps);
  return {
    identity: {
      schema: build.schema,
      package: { ...build.package },
      source: { ...build.source },
      artifact: {
        channel: build.artifact.channel,
        sha256: executableSha256(executablePath),
      },
      runtime: {
        executable_path: executablePath,
        invocation: resolvedDeps.invocation(),
        launch_mode: launch.mode,
        launch_confidence: launch.confidence,
      },
      compatibility_contracts: { ...build.compatibility_contracts },
    },
    drift: {
      adjacent_package_version: adjacent,
      version_mismatch: adjacent !== null && adjacent !== build.package.version,
    },
  };
}
