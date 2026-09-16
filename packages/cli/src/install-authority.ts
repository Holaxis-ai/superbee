import { currentHost, distributionLayouts } from "./runtime-context.js";
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

export function npmPrefixInvocation(_platform:string=process.platform,_env:NodeJS.ProcessEnv=process.env,realpath:(path:string)=>string|undefined=defaultRealpath,runtimePath:string=process.execPath):{command:string;args:string[]}|undefined {return currentHost().npmPrefixInvocation(runtimePath,realpath);}

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

function containsNpxCache(candidate:string|null|undefined,_platform:string):boolean {
 return (candidate?.split(/[\\/]/)??[]).some(segment=>currentHost().sameResolvedPath(segment,'_npx'));
}
function pathApi(_platform:string) {return currentHost().paths;}
function isScopedNpmPackageExecutable(candidate:string|null,_platform:string):boolean {
 if(!candidate)return false;
 const host=currentHost();const normalized=host.paths.normalize(candidate);
 return distributionLayouts().some(layout=>{
   const suffix=host.paths.join('node_modules',...layout.packageName.split('/'),layout.entryRelativePath);
   return host.sameResolvedPath(normalized.slice(-suffix.length),suffix);
 });
}
interface NpmInstallRule {executable:string;commands:readonly string[];}
function npmInstallRule(prefix:string,executable:string,_platform:string):NpmInstallRule|undefined {
 const host=currentHost();
 for(const layout of distributionLayouts()) {
   const expected=host.npmGlobalPaths(prefix,layout).executable;
   if(host.sameResolvedPath(expected,executable))return {executable:expected,commands:layout.bins};
 }
 return undefined;
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
  if (!["darwin","linux",currentHost().id].includes(input.platform))return unknown(input,"durable npm-global layout is unsupported on this platform");
  if (input.env.npm_command === "exec" || input.env.npm_lifecycle_event === "npx") {
    return unknown(input, "npm-exec/npx environment cannot authorize a persistent install");
  }
  if (!input.executable_path || containsNpxCache(input.executable_path, input.platform)) {
    return unknown(input, "running executable is missing or resides in an npm-exec/npx cache");
  }

  const executable = input.realpath(input.executable_path);
  if (!executable || containsNpxCache(executable, input.platform)) {
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
  const prefixBin = currentHost().npmGlobalPaths(prefix,distributionLayouts()[0]!).binDirectory;
  const resolvedPrefixBin = input.realpath(prefixBin);
  if (!resolvedPrefixBin) {
    return unknown(input, "npm global prefix bin directory cannot be resolved");
  }
  const installRule = npmInstallRule(prefix, executable, input.platform);
  if (!installRule) {
    return unknown(input, "running executable is outside the supported npm global package layout");
  }
  const rawPath = input.env.PATH;
  if (!rawPath) {
    return unknown(input, "PATH is missing, so managed command authority cannot be established");
  }
  const pathDirs = rawPath.split(paths.delimiter);
  if (pathDirs.some((dir) => dir.trim().length === 0)) {
    return unknown(input, "current-directory PATH entry prevents durable command authority");
  }
  for (const name of installRule.commands) {
    for (const dir of pathDirs) {
      const candidates = currentHost().executableCandidates(dir,name,input.env);
      let found = false;
      for (const candidate of candidates) {
        const resolved = input.realpath(candidate);
        if (resolved === undefined) continue;
        found = true;
        const resolvedDir = input.realpath(paths.normalize(dir));
        if(currentHost().sameResolvedPath(resolvedDir??'',resolvedPrefixBin)
          && currentHost().binMatches(candidate,resolved,executable,input.runtime_path??'',distributionLayouts())) {
          selectedBin=currentHost().installedBinPath(prefixBin,name);
        }
        break;
      }
      // Command lookup stops at the first existing entry for an alias. A later matching entry
      // cannot rescue a shadowed one.
      if (found) break;
    }
    if (selectedBin !== null) break;
  }
  if (selectedBin === null || containsNpxCache(selectedBin, input.platform)) {
    return unknown(input, "no managed PATH bin resolves to the running executable");
  }

  const supportedBins=installRule.commands.map(name=>currentHost().installedBinPath(prefixBin,name));
  if(!supportedBins.some(bin=>currentHost().sameResolvedPath(bin,selectedBin!))) {
    return unknown(input,'managed PATH bin is outside the npm global prefix bin directory');
  }
  if (
    !input.runtime_path
    || !paths.isAbsolute(input.runtime_path)
    || containsNpxCache(input.runtime_path, input.platform)
  ) {
    return unknown(input, "running Node executable is missing or transient");
  }
  const runtime = input.realpath(input.runtime_path);
  if (!runtime || containsNpxCache(runtime, input.platform)) {
    return unknown(input, "running Node executable cannot be resolved as one durable file");
  }
  const stableRuntimePath = currentHost().stableRuntimePath(prefixBin,runtime);
  const stableRuntime = input.realpath(stableRuntimePath);
  if (!stableRuntime || !currentHost().sameResolvedPath(runtime,stableRuntime)) {
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
