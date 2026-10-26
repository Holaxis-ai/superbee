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
  const context = snapshotRuntimeOptions(options);
  return Object.freeze({
    run: (argv: readonly string[]) =>
      runWithRuntime(context, async () => {
        await (await import("./cli.js")).main([...argv]);
      }),
    runFirstParty: (argv: readonly string[]) => runWithRuntime(context, async () => {
      const started = Date.now();
      const { withFirstPartySync }=await import('./commands/sync/transfer-worker.js');
      const run = async()=>{await(await import('./cli.js')).main([...argv]);};
      if (argv[0] === 'sync' || argv[0] === 'turn-end') await withFirstPartySync(run, started);
      else await run();
    }),
    runGitSyncWorker: () => runWithRuntime(context, async () => {await(await import('./commands/sync/transfer-worker.js')).runGitSyncWorker();}),
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
