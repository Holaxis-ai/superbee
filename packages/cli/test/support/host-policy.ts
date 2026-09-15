import {
  createPosixHostCommands,
  createPosixPrivateStateHost,
} from "../../src/posix-host.js";
import { runWithRuntime } from "../../src/runtime-context.js";
import type {
  HostCommands,
  PrivateStateHost,
} from "../../src/runtime-types.js";
export function withTestPolicy<T>(
  overrides: {
    host?: Partial<HostCommands>;
    privateState?: Partial<PrivateStateHost>;
  },
  body: () => T,
): T {
  return runWithRuntime(
    {
      distribution: {
        identity: {
          schema: "superbee.build-identity.v1",
          package: { name: "superbee", version: "unknown" },
          source: { commit: null, dirty: null },
          artifact: { channel: "local-dev" },
          compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
        },
        executablePath: "",
        assetRoot: "",
        install: {
          packageName: "superbee",
          entryRelativePath: "dist/superbee.mjs",
          bins: ["superbee"],
        },
        predecessorLayouts: [],
        ownedSkillPackages: ["superbee"],
        updatesEnabled: false,
      },
      host: { ...createPosixHostCommands(), ...overrides.host },
      privateState: {
        ...createPosixPrivateStateHost(),
        ...overrides.privateState,
      },
    },
    body,
  );
}
