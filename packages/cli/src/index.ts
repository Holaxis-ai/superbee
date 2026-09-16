/** Process-oriented composition: one immutable executable identity per process. Importing this
 * module does not dispatch argv. Commands retain the host's cwd, environment and output streams. */
import * as identity from "./build-identity.js";
import * as invocation from "./invocation.js";
import type { SourcePackageIdentity, StaticBuildIdentity, BuildIdentityEnvelope } from "./public-types.js";
export type { SourcePackageIdentity, StaticBuildIdentity, BuildIdentityEnvelope } from "./public-types.js";
export function configureSourceIdentity(value: SourcePackageIdentity): void { identity.configureSourceIdentity(value); }
export function cliVersion(): string { return identity.cliVersion(); }
export function isBareVersionFlag(value: string | undefined): boolean { return identity.isBareVersionFlag(value); }
export function buildIdentityEnvelope(): BuildIdentityEnvelope { return identity.buildIdentityEnvelope(); }
export function staticBuildIdentity(): StaticBuildIdentity { return identity.staticBuildIdentity(); }
export function registerExecutableEntry(entryPath: string): void { invocation.registerExecutableEntry(entryPath); }
export function currentExecutableRealPath(): string | undefined { return invocation.currentExecutableRealPath(); }
export async function main(argv: string[]): Promise<void> { (await import("./posix-host.js")).assertSupportedCliHost(); await (await import("./cli.js")).main(argv); }
/** Private worker protocols are routed by the executable, never by an import side effect. */
export async function runManagedUiWorker(): Promise<void> { await (await import("./ui/managed-worker.js")).runManagedUiWorker(); }
export async function runUpdateRefreshWorker(token: string): Promise<void> { await (await import("./update-orientation.js")).runUpdateRefreshWorker(token); }

export { createCliRuntime, createPosixCliRuntime } from './runtime.js';
export { HostCommandError } from './host-command-error.js';
export type { CliRuntime, CliRuntimeOptions, CliDistribution, DistributionInstallLayout, HostCommands, PrivateStateHost, FilesystemHostPolicy, BoardHostPolicy, HostCommandEnvironment, ResolvedHostCommand, HostCommandDeps, LexicalHookToken, UserStateEnvironment, UserStatePolicy, MigrationSourceDescriptor } from './runtime-types.js';
