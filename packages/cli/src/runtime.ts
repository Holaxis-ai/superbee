import * as identity from "./build-identity.js";
import * as invocation from "./invocation.js";
import { snapshotRuntimeOptions, runWithRuntime } from "./runtime-context.js";
import {
  assertSupportedCliHost,
  createPosixHostCommands,
  createPosixPrivateStateHost,
} from "./posix-host.js";
import type {
  CliRuntime,
  CliRuntimeOptions,
  CliDistribution,
} from "./runtime-types.js";

function construct(
  options: Parameters<typeof snapshotRuntimeOptions>[0],
): CliRuntime {
  // Existing process identity and the full descriptor must agree before any command is dispatched.
  const established = identity.staticBuildIdentity();
  if (
    established.package.version !== "unknown" &&
    (established.package.name !== options.distribution.identity.package.name ||
      established.package.version !==
        options.distribution.identity.package.version)
  )
    throw new Error(
      "CLI distribution conflicts with established build identity",
    );
  const context = snapshotRuntimeOptions(options);
  invocation.registerExecutableEntry(context.distribution.executablePath);
  return Object.freeze({
    run: (argv: readonly string[]) =>
      runWithRuntime(context, async () => {
        await (await import("./cli.js")).main([...argv]);
      }),
    runManagedUiWorker: () =>
      runWithRuntime(context, async () => {
        await (await import("./ui/managed-worker.js")).runManagedUiWorker();
      }),
    runUpdateRefreshWorker: (token: string) =>
      runWithRuntime(context, async () => {
        await (
          await import("./update-orientation.js")
        ).runUpdateRefreshWorker(token);
      }),
  });
}
export function createCliRuntime(options: CliRuntimeOptions): CliRuntime {
  return construct(options);
}
export function createPosixCliRuntime(
  distribution: CliDistribution,
): CliRuntime {
  assertSupportedCliHost();
  return construct({
    distribution,
    host: createPosixHostCommands(),
    privateState: createPosixPrivateStateHost(),
  });
}
