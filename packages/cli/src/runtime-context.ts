import { realpathSync } from "node:fs";
import { snapshotHostPolicy as snapshot } from "@superbee/core/filesystem";
import { assertDistributionBuildIdentity } from "./build-identity.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CliRuntimeOptions,
  CliDistribution,
  DistributionInstallLayout,
  HostCommands,
  PrivateStateHost,
  FilesystemHostPolicy,
  BoardHostPolicy,
} from "./runtime-types.js";
import {
  createPosixHostCommands,
  createPosixPrivateStateHost,
} from "./posix-host.js";

type RuntimeOptions = Omit<CliRuntimeOptions, "filesystemHost" | "boardHost"> &
  Partial<Pick<CliRuntimeOptions, "filesystemHost" | "boardHost">>;
type BoardStateLocation = { readonly dir: string } | { readonly invalid: string };
type RuntimeContext = Omit<RuntimeOptions, "boardStateDir"> & {
  readonly boardStateLocation?: BoardStateLocation | undefined;
};

export const BOARD_STATE_DIR_ENV = "SUPERBEE_BOARD_STATE_DIR";

function boardStateLocation(host: HostCommands, value: string | undefined): BoardStateLocation | undefined {
  if (value === undefined) return undefined;
  const { paths } = host;
  const normalized = paths.normalize(value);
  const native = paths.sep === "\\" ? normalized.replaceAll("\\", "/") : normalized;
  const root = paths.parse(native).root;
  const fullyQualified = paths.sep !== "\\" || /^[a-z]:\/$/i.test(root)
    || /^\/\/[^/]+\/[^/]+\/$/.test(root) && !/^\/\/[?.]\//.test(native);
  return Object.freeze(
    paths.isAbsolute(value) && fullyQualified && !value.includes("\0") && host.isCanonicalAbsolutePath(native)
      ? { dir: normalized }
      : { invalid: value },
  );
}
const contexts = new AsyncLocalStorage<Readonly<RuntimeContext> | undefined>();
let defaultHost: HostCommands | undefined;
let defaultPrivateState: PrivateStateHost | undefined;
let distribution: Readonly<CliDistribution> | undefined;
let distributionKey: string | undefined;
let registeredExecutableEntry: string | undefined;

function resolveExecutableEntry(entryPath: string): string | undefined {
  try { return realpathSync(entryPath); } catch { return undefined; }
}

function validateExecutableEntry(resolved: string): void {
  if (registeredExecutableEntry && registeredExecutableEntry !== resolved) {
    throw new Error(`CLI executable entry was already registered as ${registeredExecutableEntry}; refusing ${resolved}`);
  }
}

/** Unresolvable standalone registrations remain inert; runtime construction requires a real entry. */
export function registerExecutableEntry(entryPath: string): void {
  const resolved = resolveExecutableEntry(entryPath);
  if (!resolved) return;
  validateExecutableEntry(resolved);
  registeredExecutableEntry = resolved;
}

export function currentExecutableRealPath(): string | undefined {
  return registeredExecutableEntry;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export function snapshotRuntimeOptions(
  input: RuntimeOptions,
): Readonly<RuntimeContext> {
  const copy = deepFreeze(
    JSON.parse(JSON.stringify(input.distribution)) as CliDistribution,
  );
  const key = JSON.stringify(copy);
  const host = snapshot(input.host);
  const context = Object.freeze({
    distribution: copy,
    existingGitBoard: input.existingGitBoard && Object.freeze({ ...input.existingGitBoard }),
    host,
    boardStateLocation: boardStateLocation(host, input.boardStateDir ?? process.env[BOARD_STATE_DIR_ENV]),
    privateState: snapshot(input.privateState),
    filesystemHost: input.filesystemHost
      ? snapshot(input.filesystemHost)
      : undefined,
    boardHost: input.boardHost ? snapshot(input.boardHost) : undefined,
  });
  if (distributionKey !== undefined && distributionKey !== key)
    throw new Error(
      "CLI distribution configuration was already bound; refusing conflicting configuration",
    );
  if (
    copy.identity.package.name !== copy.install.packageName ||
    !copy.install.bins.length
  )
    throw new Error(
      "CLI distribution identity and installation layout disagree",
    );
  if (
    !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(copy.install.packageName) ||
    copy.install.bins.some((name) => !/^[a-z0-9._-]+$/.test(name))
  )
    throw new Error("Invalid CLI distribution package or bin identity");
  if (
    copy.install.entryRelativePath.startsWith("/") ||
    copy.install.entryRelativePath
      .split(/[\\/]/)
      .some((part) => part === ".." || part === "")
  )
    throw new Error("Invalid CLI distribution entry layout");
  if (copy.updatesEnabled && copy.install.packageName !== "superbee")
    throw new Error("Update policy is unavailable for this distribution");
  assertDistributionBuildIdentity(copy.identity);
  const resolved = resolveExecutableEntry(copy.executablePath);
  if (!resolved) throw new Error("CLI distribution executable entry could not be resolved");
  validateExecutableEntry(resolved);
  // All user-controlled reads and fallible validation precede this synchronous commit.
  registeredExecutableEntry = resolved;
  distribution ??= copy;
  distributionKey = key;
  return context;
}
export function runWithRuntime<T>(
  context: Readonly<RuntimeContext>,
  body: () => T,
): T {
  return contexts.run(context, body);
}
export function captureRuntimeCallback<T extends (...args: any[]) => any>(
  fn: T,
): T {
  const context = contexts.getStore();
  return ((...args: Parameters<T>) => contexts.run(context, () => fn(...args))) as T;
}
export function currentHost(): HostCommands {
  return (
    contexts.getStore()?.host ?? (defaultHost ??= createPosixHostCommands())
  );
}
export function currentPrivateStateHost(): PrivateStateHost {
  return (
    contexts.getStore()?.privateState ??
    (defaultPrivateState ??= createPosixPrivateStateHost())
  );
}
export function currentFilesystemHost(): FilesystemHostPolicy | undefined {
  return contexts.getStore()?.filesystemHost;
}
export function currentBoardHost(): BoardHostPolicy | undefined {
  return contexts.getStore()?.boardHost;
}
export function currentDistribution(): Readonly<CliDistribution> | undefined {
  return distribution;
}
export function distributionPackageName(): string {
  return distribution?.install.packageName ?? "superbee";
}
export function distributionBinName(): string {
  return distribution?.install.bins[0] ?? "superbee";
}
export function distributionLayouts(): readonly DistributionInstallLayout[] {
  return [distribution?.install ?? { packageName: "superbee", entryRelativePath: "dist/superbee.mjs", bins: ["superbee"] }];
}
export function installCommand(): string {
  return `npm install -g ${distributionPackageName()}`;
}

export function currentBoardStateLocation(): BoardStateLocation | undefined {
  return contexts.getStore()?.boardStateLocation;
}

export function currentExistingGitBoard(): CliRuntimeOptions["existingGitBoard"] {
  return contexts.getStore()?.existingGitBoard;
}

/** The distribution switch remains supported for embedders that only restrict sync. */
export function syncExistingGitBoardsOnly(): boolean {
  return currentExistingGitBoard() !== undefined || currentDistribution()?.syncExistingGitBoardsOnly === true;
}
