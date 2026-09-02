#!/usr/bin/env node
// `axi` CLI entry point.
// Thin bin wrapper: delegate to the dispatcher (./cli.ts), which wires axi-sdk-js's runAxiCli. The
// throw->exit mapping lives in cli.ts's `formatError`; runAxiCli sets `process.exitCode` (never
// `process.exit`), so the full 0/1/2/4/5/6 taxonomy survives and the process drains naturally. argv
// is passed explicitly so tests can inject it.
import { fileURLToPath } from "node:url";
import { cliVersion, isBareVersionFlag } from "./build-identity.js";

const argv = process.argv.slice(2);
const bareVersion = isBareVersionFlag(argv[0]);
if (bareVersion) {
  process.stdout.write(`${cliVersion()}\n`);
} else {
  const { registerExecutableEntry } = await import("./invocation.js");
  registerExecutableEntry(fileURLToPath(import.meta.url));
}

if (!bareVersion && argv[0] === "__managed-ui-v1") {
  // Private managed-listener route. Configuration and both secrets arrive over the child's
  // bounded stdin pipe, never argv, the process list, browser URL, or public command registry.
  if (argv.length === 1) {
    const { runManagedUiWorker } = await import("./ui/managed-worker.js");
    await runManagedUiWorker();
  }
} else if (!bareVersion && argv[0] === "__update-refresh-v1") {
  // Private process route: malformed argv is intentionally silent zero-work. It is absent from
  // public command registries/help and is reachable only through the exact registered entry.
  if (argv.length === 2) {
    const { runUpdateRefreshWorker } = await import("./update-orientation.js");
    await runUpdateRefreshWorker(argv[1]!);
  }
} else if (!bareVersion) {
  const { main } = await import("./cli.js");
  await main(argv);
}
