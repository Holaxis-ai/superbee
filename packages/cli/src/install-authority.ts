// Read-only authority for persistent integration installs.
//
// `npm exec`/npx can put a transient cache bin on PATH, so PATH equality alone cannot authorize
// durable host changes. npm-package bytes must prove one supported platform npm-global layout.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ArtifactChannel } from "./build-identity.js";
import { buildIdentityEnvelope } from "./build-identity.js";

export type PersistentInstallAuthorityState =
  | "durable_global"
  | "local_dev"
  | "unknown";

export type PersistentInstallAuthorityFailure = "npm_prefix_runtime_unavailable";

export interface PersistentInstallAuthority {
  allowed: boolean;
  state: PersistentInstallAuthorityState;
  reason: string;
  failure?: PersistentInstallAuthorityFailure;
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

function unknown(
  input: PersistentInstallAuthorityInput,
  reason: string,
  failure?: PersistentInstallAuthorityFailure,
): PersistentInstallAuthority {
  return {
    allowed: false,
    state: "unknown",
    reason,
    ...(failure ? { failure } : {}),
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

export function npmPrefixInvocation(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | undefined {
  if (platform !== "win32") return { command: "npm", args: ["prefix", "--global"] };
  const command = env.ComSpec?.trim() || env.COMSPEC?.trim();
  if (!command || !path.win32.isAbsolute(command)) return undefined;
  // npm's supported Windows executable is a .cmd shim. Node cannot execFile that shim directly;
  // invoke the constant, argument-free probe through the absolute system command processor.
  return { command, args: ["/d", "/s", "/c", "npm.cmd prefix --global"] };
}

function defaultNpmPrefixGlobal(): string | undefined {
  try {
    const invocation = npmPrefixInvocation();
    if (!invocation) return undefined;
    const stdout = execFileSync(invocation.command, invocation.args, {
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

function pathApi(platform: string): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function isScopedNpmPackageExecutable(candidate: string | null, platform: string): boolean {
  const paths = pathApi(platform);
  if (!candidate || !paths.isAbsolute(candidate)) return false;
  const suffixes = [
    paths.join(...(platform === "win32" ? [] : ["lib"]), "node_modules", "superbee", "dist", "superbee.mjs"),
    paths.join(...(platform === "win32" ? [] : ["lib"]), "node_modules", "@holaxis", "aslite", "dist", "superbee.mjs"),
  ];
  const normalized = paths.normalize(candidate);
  return suffixes.some((suffix) => normalized.endsWith(`${paths.sep}${suffix}`));
}

interface NpmInstallRule {
  executable: string;
  commands: readonly string[];
}

/** Bind PATH command authority to the package identity proven by its exact npm-global layout. */
function npmInstallRule(prefix: string, executable: string, platform: string): NpmInstallRule | undefined {
  const paths = pathApi(platform);
  const packageBase = [prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules"];
  const rules: NpmInstallRule[] = [
    {
      executable: paths.join(...packageBase, "superbee", "dist", "superbee.mjs"),
      commands: ["superbee"],
    },
    {
      executable: paths.join(...packageBase, "@holaxis", "aslite", "dist", "superbee.mjs"),
      commands: ["aslite", "agentstate-lite"],
    },
  ];
  const comparableExecutable = platform === "win32"
    ? paths.normalize(executable).toLowerCase()
    : paths.normalize(executable);
  return rules.find((rule) => (
    platform === "win32"
      ? paths.normalize(rule.executable).toLowerCase()
      : paths.normalize(rule.executable)
  ) === comparableExecutable);
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim() || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
}

/** Classify an already-resolved running distribution. Performs no writes. */
export function classifyPersistentInstallAuthority(
  input: PersistentInstallAuthorityInput,
): PersistentInstallAuthority {
  const paths = pathApi(input.platform);
  const evidence = {
    npm_prefix: null,
    bin_path: null,
    executable_path: input.executable_path,
    runtime_path: input.runtime_path,
  };
  const installedLocalDev =
    input.artifact_channel === "local-dev"
    && isScopedNpmPackageExecutable(input.executable_path, input.platform);
  if (input.artifact_channel === "local-dev" && !installedLocalDev) {
    return { allowed: true, state: "local_dev", reason: "developer build", evidence };
  }
  if (input.artifact_channel !== "npm-package" && !installedLocalDev) {
    return unknown(input, "running build channel cannot authorize persistent integration changes");
  }
  if (input.platform !== "darwin" && input.platform !== "linux" && input.platform !== "win32") {
    return unknown(input, "durable npm-global layout is unsupported on this platform");
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
  if (!prefixRaw || !paths.isAbsolute(prefixRaw)) {
    return unknown(input, "npm prefix --global did not return one absolute prefix");
  }
  const prefix = input.realpath(paths.normalize(prefixRaw));
  if (!prefix || !paths.isAbsolute(prefix)) {
    return unknown(input, "npm global prefix cannot be resolved");
  }

  let selectedBin: string | null = null;
  const prefixBin = input.platform === "win32" ? paths.normalize(prefix) : paths.normalize(paths.join(prefix, "bin"));
  const resolvedPrefixBin = input.realpath(prefixBin);
  if (!resolvedPrefixBin) {
    return unknown(input, "npm global prefix bin directory cannot be resolved");
  }
  const installRule = npmInstallRule(prefix, executable, input.platform);
  if (!installRule) {
    return unknown(input, "running executable is outside the supported npm global package layout");
  }
  const pathDirs = (input.env.PATH ?? "").split(paths.delimiter).filter(Boolean);
  for (const name of installRule.commands) {
    for (const dir of pathDirs) {
      const candidates = input.platform === "win32"
        ? windowsPathExtensions(input.env).map((extension) => paths.normalize(paths.join(dir, `${name}${extension}`)))
        : [paths.normalize(paths.join(dir, name))];
      let found = false;
      for (const candidate of candidates) {
        const resolved = input.realpath(candidate);
        if (resolved === undefined) continue;
        found = true;
        const resolvedDir = input.realpath(paths.normalize(dir));
        if (input.platform === "win32") {
          const expectedShim = paths.normalize(paths.join(prefixBin, `${name}.cmd`));
          if (
            resolvedDir === resolvedPrefixBin
            && paths.normalize(candidate).toLowerCase() === expectedShim.toLowerCase()
            && paths.normalize(resolved).toLowerCase() === expectedShim.toLowerCase()
          ) {
            selectedBin = expectedShim;
          }
        } else if (resolved === executable && resolvedDir === resolvedPrefixBin) {
          selectedBin = paths.normalize(paths.join(prefixBin, name));
        }
        break;
      }
      // Command lookup stops at the first existing entry for an alias. A later matching entry
      // cannot rescue a shadowed one.
      if (found) break;
    }
    if (selectedBin !== null) break;
  }
  if (selectedBin === null || containsNpxCache(selectedBin)) {
    return unknown(input, "no managed PATH bin resolves to the running executable");
  }

  const supportedBins = new Set(installRule.commands.map((name) => {
    const candidate = paths.normalize(paths.join(
      prefixBin,
      input.platform === "win32" ? `${name}.cmd` : name,
    ));
    return input.platform === "win32" ? candidate.toLowerCase() : candidate;
  }));
  if (!supportedBins.has(input.platform === "win32" ? selectedBin.toLowerCase() : selectedBin)) {
    return unknown(input, "managed PATH bin is outside the npm global prefix bin directory");
  }
  if (!input.runtime_path || !paths.isAbsolute(input.runtime_path) || containsNpxCache(input.runtime_path)) {
    return unknown(input, "running Node executable is missing or transient");
  }
  const runtime = input.realpath(input.runtime_path);
  if (!runtime || containsNpxCache(runtime)) {
    return unknown(input, "running Node executable cannot be resolved as one durable file");
  }
  if (input.platform === "win32") {
    return {
      allowed: true,
      state: installedLocalDev ? "local_dev" : "durable_global",
      reason: installedLocalDev ? "installed developer build" : "durable Windows npm-global executable",
      evidence: {
        npm_prefix: prefix,
        bin_path: selectedBin,
        executable_path: executable,
        runtime_path: runtime,
      },
    };
  }
  const stableRuntimePath = paths.normalize(paths.join(prefixBin, "node"));
  const stableRuntime = input.realpath(stableRuntimePath);
  if (!stableRuntime || runtime !== stableRuntime) {
    return unknown(
      input,
      "npm global prefix does not provide the running Node launcher required for durable host integration",
      "npm_prefix_runtime_unavailable",
    );
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
