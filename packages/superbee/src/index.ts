#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cliVersion,
  isBareVersionFlag,
  configureSourceIdentity,
  staticBuildIdentity,
  createCliRuntime,
  createPosixCliRuntime,
  type CliDistribution,
} from "@superbee/cli";
import { windowsBoardHostPolicy } from "./windows/board.js";
import { windowsFilesystemHostPolicy } from "./windows/filesystem.js";
import { createWindowsHostCommands } from "./windows/host.js";
import { windowsPrivateStateHost } from "./windows/private-state.js";

declare const __SUPERBEE_BUILD_IDENTITY__: unknown;
if (typeof __SUPERBEE_BUILD_IDENTITY__ === "undefined") {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  configureSourceIdentity({ name: manifest.name, version: manifest.version });
}

const argv = process.argv.slice(2);
const command = argv[0];
const windows = process.platform === "win32";
const posix = process.platform === "darwin" || process.platform === "linux";
const windowsUsage = "Native Windows works with existing Git boards. Use WSL2 for the full CLI.";
const windowsRuntimeRequirement = "Native Windows Git board operations require Node.js 22.17.0 or later in the 22 line, 24.2.0 or later in the 24 line, or Node.js 26.";

// libuv 1.51.0 made Windows path and handle stats agree on the volume serial used for file identity.
// https://github.com/libuv/libuv/blob/v1.51.0/ChangeLog
function hasWindowsFileIdentitySupport(): boolean {
  const [major, minor] = process.versions.uv.split(".");
  return Number(major) > 1 || (major === "1" && Number(minor) >= 51);
}

if (isBareVersionFlag(command)) {
  process.stdout.write(`${cliVersion()}\n`);
} else if (!windows && !posix) {
  process.stdout.write("error:\n  code: RUNTIME\n  message: Superbee runs on macOS, Linux, and native Windows (existing Git boards).\n");
  process.exitCode = 1;
} else {
  const executablePath = fileURLToPath(import.meta.url);
  const distribution: CliDistribution = {
    identity: staticBuildIdentity(),
    executablePath,
    assetRoot: dirname(dirname(executablePath)),
    install: { packageName: "superbee", entryRelativePath: "dist/superbee.mjs", bins: ["superbee"] },
    ownedSkillPackages: ["superbee", "aslite", "@holaxis/aslite"],
    updatesEnabled: posix,
  };
  const runtime = windows
    ? createCliRuntime({
        distribution,
        existingGitBoard: {
          usage: windowsUsage,
          requirements: windowsRuntimeRequirement,
          ...(!hasWindowsFileIdentitySupport() && {
            unavailableReason: `${windowsRuntimeRequirement} Found Node.js ${process.versions.node}.`,
          }),
        },
        host: createWindowsHostCommands(),
        privateState: windowsPrivateStateHost,
        filesystemHost: windowsFilesystemHostPolicy,
        boardHost: windowsBoardHostPolicy,
      })
    : createPosixCliRuntime(distribution);
  if (posix && command === "__managed-ui-v1") {
    if (argv.length === 1) await runtime.runManagedUiWorker();
  } else if (posix && command === "__update-refresh-v1") {
    if (argv.length === 2) await runtime.runUpdateRefreshWorker(argv[1]!);
  } else {
    await runtime.run(argv);
  }
}
