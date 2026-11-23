#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cliVersion,
  isBareVersionFlag,
  configureSourceIdentity,
  staticBuildIdentity,
  createWindowsCliRuntime,
  createPosixCliRuntime,
  type CliDistribution,
} from "@superbee/cli";
declare const __SUPERBEE_BUILD_IDENTITY__: unknown;
if (typeof __SUPERBEE_BUILD_IDENTITY__ === "undefined") {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  configureSourceIdentity({ name: manifest.name, version: manifest.version });
}

const argv = process.argv.slice(2);
const command = argv[0];
const windows = process.platform === "win32";
const posix = process.platform === "darwin" || process.platform === "linux";
if (isBareVersionFlag(command)) {
  process.stdout.write(`${cliVersion()}\n`);
} else if (!windows && !posix) {
  process.stdout.write("error:\n  code: RUNTIME\n  message: Superbee runs on macOS, Linux, and native Windows (local projects and existing Git boards).\n");
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
    ? createWindowsCliRuntime(distribution)
    : createPosixCliRuntime(distribution);
  if (posix && command === "__managed-ui-v1") {
    if (argv.length === 1) await runtime.runManagedUiWorker();
  } else if (posix && command === "__update-refresh-v1") {
    if (argv.length === 2) await runtime.runUpdateRefreshWorker(argv[1]!);
  } else {
    await runtime.run(argv);
  }
}
