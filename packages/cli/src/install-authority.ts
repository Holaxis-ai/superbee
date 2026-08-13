// Read-only authority for persistent integration installs.
//
// `npm exec`/npx can put a transient cache bin on PATH, so PATH equality alone cannot authorize
// durable host changes. npm-package bytes must prove the supported POSIX npm-global layout.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, normalize, sep } from "node:path";
import type { ArtifactChannel } from "./build-identity.js";
import { buildIdentityEnvelope } from "./build-identity.js";
import { BIN_NAMES } from "./invocation.js";

export type PersistentInstallAuthorityState =
  | "durable_global"
  | "local_dev"
  | "unknown";

export interface PersistentInstallAuthority {
  allowed: boolean;
  state: PersistentInstallAuthorityState;
  reason: string;
  evidence: {
    npm_prefix: string | null;
    bin_path: string | null;
    executable_path: string | null;
    runtime_path: string | null;
  };
}

export interface PersistentInstallAuthorityInput {
  artifact_channel: ArtifactChannel;
  executable_path: string | null;
  runtime_path: string | null;
  env: NodeJS.ProcessEnv;
  platform: string;
  npm_prefix_global: () => string | undefined;
  realpath: (path: string) => string | undefined;
}

function unknown(input: PersistentInstallAuthorityInput, reason: string): PersistentInstallAuthority {
  return {
    allowed: false,
    state: "unknown",
    reason,
    evidence: {
      npm_prefix: null,
      bin_path: null,
      executable_path: input.executable_path,
      runtime_path: input.runtime_path,
    },
  };
}

function defaultRealpath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function defaultNpmPrefixGlobal(): string | undefined {
  try {
    const stdout = execFileSync("npm", ["prefix", "--global"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    return stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

function containsNpxCache(candidate: string | null | undefined): boolean {
  return candidate?.split(/[\\/]/).includes("_npx") ?? false;
}

function isScopedNpmPackageExecutable(candidate: string | null): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const suffixes = [
    join("lib", "node_modules", "superbee", "dist", "superbee.mjs"),
    join("lib", "node_modules", "@holaxis", "aslite", "dist", "superbee.mjs"),
  ];
  const normalized = normalize(candidate);
  return suffixes.some((suffix) => normalized.endsWith(`${sep}${suffix}`));
}

/** Classify an already-resolved running distribution. Performs no writes. */
export function classifyPersistentInstallAuthority(
  input: PersistentInstallAuthorityInput,
): PersistentInstallAuthority {
  const evidence = {
    npm_prefix: null,
    bin_path: null,
    executable_path: input.executable_path,
    runtime_path: input.runtime_path,
  };
  const installedLocalDev =
    input.artifact_channel === "local-dev" && isScopedNpmPackageExecutable(input.executable_path);
  if (input.artifact_channel === "local-dev" && !installedLocalDev) {
    return { allowed: true, state: "local_dev", reason: "developer build", evidence };
  }
  if (input.artifact_channel !== "npm-package" && !installedLocalDev) {
    return unknown(input, "running build channel cannot authorize persistent integration changes");
  }
  if (input.platform !== "darwin" && input.platform !== "linux") {
    return unknown(input, "durable npm-global layout is supported only on macOS and Linux");
  }
  if (input.env.npm_command === "exec" || input.env.npm_lifecycle_event === "npx") {
    return unknown(input, "npm-exec/npx environment cannot authorize a persistent install");
  }
  if (!input.executable_path || containsNpxCache(input.executable_path)) {
    return unknown(input, "running executable is missing or resides in an npm-exec/npx cache");
  }

  const executable = input.realpath(input.executable_path);
  if (!executable || containsNpxCache(executable)) {
    return unknown(input, "running executable cannot be resolved as a durable file");
  }
  const prefixRaw = input.npm_prefix_global();
  if (!prefixRaw || !isAbsolute(prefixRaw)) {
    return unknown(input, "npm prefix --global did not return one absolute prefix");
  }
  const prefix = input.realpath(normalize(prefixRaw));
  if (!prefix || !isAbsolute(prefix)) {
    return unknown(input, "npm global prefix cannot be resolved");
  }

  let selectedBin: string | null = null;
  const pathDirs = (input.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of BIN_NAMES) {
    for (const dir of pathDirs) {
      const candidate = normalize(join(dir, name));
      const resolved = input.realpath(candidate);
      if (resolved === undefined) continue;
      if (resolved === executable) selectedBin = candidate;
      // Command lookup stops at the first existing entry for an alias. A later matching entry
      // cannot rescue a shadowed one.
      break;
    }
    if (selectedBin !== null) break;
  }
  if (selectedBin === null || containsNpxCache(selectedBin)) {
    return unknown(input, "no managed PATH bin resolves to the running executable");
  }

  const supportedBins = new Set(BIN_NAMES.map((name) => normalize(join(prefix, "bin", name))));
  if (!supportedBins.has(selectedBin)) {
    return unknown(input, "managed PATH bin is outside the npm global prefix bin directory");
  }
  const packageExecutables = [
    join(normalize(join(prefix, "lib", "node_modules", "superbee")), "dist", "superbee.mjs"),
    join(normalize(join(prefix, "lib", "node_modules", "@holaxis", "aslite")), "dist", "superbee.mjs"),
  ];
  if (!packageExecutables.includes(executable)) {
    return unknown(input, "running executable is outside the supported npm global package layout");
  }
  if (!input.runtime_path || !isAbsolute(input.runtime_path) || containsNpxCache(input.runtime_path)) {
    return unknown(input, "running Node executable is missing or transient");
  }
  const runtime = input.realpath(input.runtime_path);
  const stableRuntimePath = normalize(join(prefix, "bin", "node"));
  const stableRuntime = input.realpath(stableRuntimePath);
  if (!runtime || !stableRuntime || runtime !== stableRuntime) {
    return unknown(input, "npm-prefix bin/node does not resolve to the running Node executable");
  }

  return {
    allowed: true,
    state: installedLocalDev ? "local_dev" : "durable_global",
    reason: installedLocalDev ? "installed developer build" : "durable npm-global executable",
    evidence: {
      npm_prefix: prefix,
      bin_path: selectedBin,
      executable_path: executable,
      runtime_path: stableRuntimePath,
    },
  };
}

export interface ResolvePersistentInstallAuthorityDeps {
  identity?: ReturnType<typeof buildIdentityEnvelope>;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  npm_prefix_global?: () => string | undefined;
  realpath?: (path: string) => string | undefined;
  runtime_path?: string;
}

/** Production projection from the one running BuildIdentityV1 authority. */
export function resolvePersistentInstallAuthority(
  deps: ResolvePersistentInstallAuthorityDeps = {},
): PersistentInstallAuthority {
  const env = deps.env ?? process.env;
  const identity = deps.identity ?? buildIdentityEnvelope({ env });
  return classifyPersistentInstallAuthority({
    artifact_channel: identity.identity.artifact.channel,
    executable_path: identity.identity.runtime.executable_path,
    runtime_path: deps.runtime_path ?? process.execPath,
    env,
    platform: deps.platform ?? process.platform,
    npm_prefix_global: deps.npm_prefix_global ?? defaultNpmPrefixGlobal,
    realpath: deps.realpath ?? defaultRealpath,
  });
}
