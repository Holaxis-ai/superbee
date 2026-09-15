import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CliRuntimeOptions,
  CliDistribution,
  HostCommands,
  PrivateStateHost,
  FilesystemHostPolicy,
  BoardHostPolicy,
} from "./runtime-types.js";
import {
  createPosixHostCommands,
  createPosixPrivateStateHost,
} from "./posix-host.js";

type RuntimeContext = Omit<CliRuntimeOptions, "filesystemHost" | "boardHost"> &
  Partial<Pick<CliRuntimeOptions, "filesystemHost" | "boardHost">>;
const contexts = new AsyncLocalStorage<Readonly<RuntimeContext>>();
let defaultHost: HostCommands | undefined;
let defaultPrivateState: PrivateStateHost | undefined;
let distribution: Readonly<CliDistribution> | undefined;
let distributionKey: string | undefined;
/** Snapshot methods without freezing or changing caller-owned objects. */
function snapshot<T extends object>(
  input: T,
  seen = new WeakMap<object, object>(),
): T {
  const existing = seen.get(input);
  if (existing) return existing as T;
  const result: Record<string, unknown> = {};
  seen.set(input, result);
  const keys = new Set<string>();
  for (
    let owner: object | null = input;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  )
    Object.getOwnPropertyNames(owner).forEach((key) => {
      if (key !== "constructor") keys.add(key);
    });
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    result[key] =
      typeof value === "function"
        ? value.bind(input)
        : value && typeof value === "object"
          ? snapshot(value, seen)
          : value;
  }
  return Object.freeze(result) as T;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export function snapshotRuntimeOptions(
  input: RuntimeContext,
): Readonly<RuntimeContext> {
  const copy = deepFreeze(
    JSON.parse(JSON.stringify(input.distribution)) as CliDistribution,
  );
  const key = JSON.stringify(copy);
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
  distribution = copy;
  distributionKey = key;
  return Object.freeze({
    distribution: copy,
    host: snapshot(input.host),
    privateState: snapshot(input.privateState),
    filesystemHost: input.filesystemHost
      ? snapshot(input.filesystemHost)
      : undefined,
    boardHost: input.boardHost ? snapshot(input.boardHost) : undefined,
  });
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
  return (
    context
      ? (...args: Parameters<T>) => contexts.run(context, () => fn(...args))
      : fn
  ) as T;
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
export function distributionLayouts() {
  return distribution
    ? [distribution.install, ...distribution.predecessorLayouts]
    : [
        {
          packageName: "superbee",
          entryRelativePath: "dist/superbee.mjs",
          bins: ["superbee"],
        },
        {
          packageName: "@holaxis/aslite",
          entryRelativePath: "dist/superbee.mjs",
          bins: ["aslite", "agentstate-lite"],
        },
      ];
}
export function installCommand(): string {
  return `npm install -g ${distributionPackageName()}`;
}
