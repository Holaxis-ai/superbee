import type {
  SpawnOptions,
  ChildProcess,
  ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import type { Stats } from "node:fs";
import type path from "node:path";
import type { StaticBuildIdentity } from "./public-types.js";

export interface FilesystemHostPolicy {
  runtimeLockParent(): string;
  runtimeOwnerKey(): string;
  readonly enforcePrivateMode: boolean;
  isTransientOpenError(error: unknown): boolean;
  isReplacementConflict(error: unknown): boolean;
  isDirectoryContentionError(error: unknown): boolean;
}
export interface BoardHostPolicy {
  sameResolvedPath(left: string, right: string): boolean;
  moveAsideHelp(path: string, note: string): string;
}
export interface DistributionInstallLayout {
  readonly packageName: string;
  readonly entryRelativePath: string;
  readonly bins: readonly string[];
}
export interface CliDistribution {
  readonly identity: StaticBuildIdentity;
  readonly executablePath: string;
  readonly install: DistributionInstallLayout;
  readonly assetRoot: string;
  readonly predecessorLayouts: readonly DistributionInstallLayout[];
  readonly ownedSkillPackages: readonly string[];
  readonly updatesEnabled: boolean;
}
export interface HostCommandEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
}
export interface ResolvedHostCommand {
  readonly display: string;
  readonly file: string;
  readonly shellWrapper: string | null;
}
export interface HostCommandDeps {
  readonly resolvePath?: (candidate: string) => string | undefined;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding & {
      windowsVerbatimArguments?: boolean;
    },
  ) => string;
}
export interface LexicalHookToken {
  readonly raw: string;
  readonly value: string;
  readonly envelope: "current" | "historical_double";
}
/** Host facts and bounded OS operations; shared code owns receipt and mutation decisions. */
export interface HostCommands {
  readonly id: string;
  readonly paths: typeof path.posix;
  resolveCommand(
    name: string,
    input: HostCommandEnvironment,
    deps?: Pick<HostCommandDeps, "resolvePath">,
  ): ResolvedHostCommand;
  runCommand(
    command: ResolvedHostCommand,
    args: readonly string[],
    input: HostCommandEnvironment,
    deps?: Pick<HostCommandDeps, "execFile">,
  ): string;
  renderShellToken(value: string): string | undefined;
  renderGeneratedHookToken(value: string): string;
  lexicalHookTokens(command: string): readonly LexicalHookToken[] | undefined;
  sameResolvedPath(left: string, right: string): boolean;
  comparisonKey(value: string): string;
  claudeDesktopConfigPath(
    home: string,
    env: NodeJS.ProcessEnv,
  ): string | undefined;
  npmPrefixInvocation(
    runtimePath: string,
    realpath: (candidate: string) => string | undefined,
  ): { command: string; args: string[] } | undefined;
  npmGlobalPaths(
    prefix: string,
    layout: DistributionInstallLayout,
  ): { executable: string; binDirectory: string };
  executableCandidates(
    directory: string,
    name: string,
    env: NodeJS.ProcessEnv,
  ): readonly string[];
  installedBinPath(prefixBin: string, name: string): string;
  binMatches(
    candidate: string,
    resolved: string,
    executable: string,
    runtimePath: string,
    layouts: readonly DistributionInstallLayout[],
  ): boolean;
  stableRuntimePath(prefixBin: string, runtime: string): string;
  isCanonicalAbsolutePath(value: string): boolean;
  isNodeRuntimePath(value: string): boolean;
  isStableRuntimePair(
    program: string,
    executable: string,
    layout: DistributionInstallLayout,
  ): boolean;
  hasAdditionalStdinInput(
    stats: Pick<Stats, "isCharacterDevice" | "isDirectory">,
  ): boolean;
  openBrowser(url: string): void;
  spawnChild(
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
}
export interface UserStateEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}
export interface UserStatePolicy {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly state: "ready" | "blocked";
  readonly canonicalRoot: string | null;
  readonly guardedRoots: readonly string[];
  readonly displayRoot: string;
  readonly reason?: string;
}
export interface MigrationSourceDescriptor {
  readonly root: string;
  readonly display: string;
  readonly requiresMarker: boolean;
}
export interface PrivateStateHost {
  readonly id: string;
  readonly enforcePrivateMode: boolean;
  environment(input?: string | UserStateEnvironment): UserStateEnvironment;
  resolvePolicy(input: UserStateEnvironment): UserStatePolicy;
  legacyRoot(input: UserStateEnvironment): string;
  supersededRoots(input: UserStateEnvironment): readonly string[];
  migrationSources(
    input: UserStateEnvironment,
  ): readonly MigrationSourceDescriptor[];
  displayPath(input: UserStateEnvironment, target: string): string;
  currentUid(): number | undefined;
  readonly privateRead: {
    readonly flags: number;
    readonly inspectBeforeOpen: boolean;
  };
  isTransientConfigReplaceError(error: unknown): boolean;
  sourceInspectionCommand(
    display: string,
    detailed: boolean,
    setupCommand: string,
  ): string;
  bundleBoundaryRecovery(rootDisplay: string, invocationPrefix: string): string;
}
export interface CliRuntimeOptions {
  readonly distribution: CliDistribution;
  readonly host: HostCommands;
  readonly privateState: PrivateStateHost;
  readonly filesystemHost: FilesystemHostPolicy;
  readonly boardHost: BoardHostPolicy;
}
export interface CliRuntime {
  run(argv: readonly string[]): Promise<void>;
  runManagedUiWorker(): Promise<void>;
  runUpdateRefreshWorker(token: string): Promise<void>;
}
