import type { CliRuntimeOptions } from "../runtime-types.js";
import { windowsBoardHostPolicy } from "./board.js";
import { windowsFilesystemHostPolicy } from "./filesystem.js";
import { createWindowsHostCommands } from "./host.js";
import { windowsPrivateStateHost } from "./private-state.js";

const windowsUsage = "Native Windows supports local project setup and existing standalone Git boards. Use WSL2 for the full CLI.";
const requirements = "Native Windows file operations require Node.js 22.17.0 or later in the 22 line, 24.2.0 or later in the 24 line, or Node.js 26.";

// libuv 1.51 made Windows path and handle stats agree on the volume serial used for file identity.
export function windowsFilesystemUnavailable(): string | undefined {
  const [major = 0, minor = 0] = process.versions.uv.split(".").map(Number);
  if (major > 1 || (major === 1 && minor >= 51)) return undefined;
  return `${requirements} Found Node.js ${process.versions.node}.`;
}

let hostOptions: Pick<CliRuntimeOptions, "host" | "privateState" | "filesystemHost" | "boardHost"> | undefined;
export function windowsHostOptions(): NonNullable<typeof hostOptions> {
  return (hostOptions ??= Object.freeze({
    host: createWindowsHostCommands(),
    privateState: windowsPrivateStateHost,
    filesystemHost: windowsFilesystemHostPolicy,
    boardHost: windowsBoardHostPolicy,
  }));
}

export function windowsRuntimeOptions(): Omit<CliRuntimeOptions, "distribution"> {
  const unavailableReason = windowsFilesystemUnavailable();
  return {
    ...windowsHostOptions(),
    existingGitBoard: {
      usage: windowsUsage,
      localOnboarding: true,
      requirements,
      ...(unavailableReason && { unavailableReason }),
    },
  };
}
