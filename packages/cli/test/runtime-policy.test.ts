import { checkSupportedRelease } from "../src/update-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPosixHostCommands,
  createPosixPrivateStateHost,
  assertSupportedCliHost,
} from "../src/posix-host.js";
import {
  snapshotRuntimeOptions,
  runWithRuntime,
  currentHost,
  currentPrivateStateHost,
  captureRuntimeCallback,
} from "../src/runtime-context.js";
import {
  configuredInitBundle,
  configuredBundle,
  withCliFilesystemMutationLock,
} from "../src/filesystem-runtime.js";
import { createWorkspacesLoader } from "../src/ui/sharing.js";
import { commandToken, commandQuoted } from "../src/command-text.js";
import type { CliRuntimeOptions } from "../src/runtime-types.js";

const distribution: CliRuntimeOptions["distribution"] = {
  identity: {
    schema: "superbee.build-identity.v1",
    package: { name: "superbee", version: "unknown" },
    source: { commit: null, dirty: null },
    artifact: { channel: "local-dev" },
    compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
  },
  executablePath: fileURLToPath(import.meta.url),
  assetRoot: fileURLToPath(new URL(".", import.meta.url)),
  install: {
    packageName: "superbee",
    entryRelativePath: "dist/superbee.mjs",
    bins: ["superbee"],
  },
  predecessorLayouts: [],
  ownedSkillPackages: ["superbee"],
  updatesEnabled: false,
};
function options(label: string, seen: string[]): CliRuntimeOptions {
  const host = createPosixHostCommands();
  const privateState = createPosixPrivateStateHost();
  return {
    distribution,
    host: { ...host, renderShellToken: (value) => `${label}:${value}` },
    privateState: {
      ...privateState,
      resolvePolicy(input) {
        seen.push(label);
        return privateState.resolvePolicy(input);
      },
    },
    filesystemHost: {
      runtimeLockParent: () => {
        seen.push(`${label}:lock`);
        return "/tmp";
      },
      runtimeOwnerKey: () => `uid-${process.getuid!()}`,
      enforcePrivateMode: true,
      isTransientOpenError: () => false,
      isReplacementConflict: () => false,
      isDirectoryContentionError: () => false,
    },
    boardHost: {
      sameResolvedPath: (a, b) => a === b,
      moveAsideHelp: () => label,
    },
  };
}
test("immutable execution snapshots isolate host methods across overlapping awaits", async () => {
  const seen: string[] = [];
  const a = options("A", seen),
    b = options("B", seen);
  const ca = snapshotRuntimeOptions(a),
    cb = snapshotRuntimeOptions(b);
  a.host.renderShellToken = () => "changed";
  assert.equal(Object.isFrozen(a.host), false);
  await Promise.all([
    runWithRuntime(ca, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(currentHost().renderShellToken("x"), "A:x");
    }),
    runWithRuntime(cb, async () => {
      await Promise.resolve();
      assert.equal(currentHost().renderShellToken("x"), "B:x");
    }),
  ]);
  assert.throws(
    () =>
      snapshotRuntimeOptions({
        ...a,
        distribution: { ...distribution, updatesEnabled: true },
      }),
    /conflicting configuration/,
  );
});
test("refused values use the shared quoted placeholder without losing command brands", () => {
  const a = options("A", []);
  a.host.renderShellToken = (value) =>
    value.includes("%") ? undefined : `'${value}'`;
  runWithRuntime(snapshotRuntimeOptions(a), () => {
    assert.equal(
      commandToken("http://x/a%20b"),
      "'<value-omitted-unquotable>'",
    );
    assert.equal(commandQuoted("a%b"), "'<value-omitted-unquotable>'");
  });
});
test("deferred callbacks and workspace loaders retain their construction context", async () => {
  const seen: string[] = [];
  const a = snapshotRuntimeOptions(options("A", seen)),
    b = snapshotRuntimeOptions(options("B", seen));
  const home = await mkdtemp(join(tmpdir(), "superbee-runtime-context-"));
  try {
    const callback = runWithRuntime(a, () =>
      captureRuntimeCallback(() => currentHost().renderShellToken("x")),
    );
    const loader = runWithRuntime(a, () => createWorkspacesLoader(home, home));
    assert.equal(callback(), "A:x");
    await runWithRuntime(b, async () => {
      assert.equal(callback(), "A:x");
      await loader();
    });
    assert.ok(seen.includes("A"));
    assert.ok(!seen.includes("B"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("configured initialization and direct locks retain the supplied core policy", async () => {
  const seen: string[] = [];
  const context = snapshotRuntimeOptions(options("A", seen));
  const home = await mkdtemp(join(tmpdir(), "superbee-runtime-fs-"));
  const root = join(home, "bundle");
  try {
    const bundle = await runWithRuntime(context, () =>
      configuredInitBundle(root),
    );
    assert.ok(bundle.backend);
    const again = runWithRuntime(context, () => configuredBundle(root));
    assert.ok(again.backend);
    await runWithRuntime(context, () =>
      withCliFilesystemMutationLock(root, async () => {}),
    );
    assert.ok(seen.includes("A:lock"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("unsupported default selection refuses without evaluating a host operation", () => {
  assert.throws(() => assertSupportedCliHost("win32"), /macOS and Linux/);
});

test("distribution disabled updates veto explicit policy before network access", async () => {
  let fetched = false;
  const result = await runWithRuntime(
    snapshotRuntimeOptions(options("A", [])),
    () =>
      checkSupportedRelease(
        { runningVersion: "1.0.0", track: "latest" },
        {
          updatePolicy: { enabled: true },
          functionalVersionFloor: "0.1.0",
          fetchImpl: async () => {
            fetched = true;
            throw new Error("unexpected fetch");
          },
        },
      ),
  );
  assert.equal(result.unavailable?.code, "policy_disabled");
  assert.equal(fetched, false);
});
