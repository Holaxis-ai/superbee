import { checkSupportedRelease } from "../src/update-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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

test("all CLI policy projections compose through captured public receivers", () => {
  const input = options("A", []);
  const host = Object.assign(input.host, { data: { suffix: "old" } });
  host.comparisonKey = function(this: typeof host, value: string) { return `${value}:${this.data.suffix}`; };
  host.sameResolvedPath = function(a, b) { return this.comparisonKey(a) === this.comparisonKey(b); };
  const privateState = Object.assign(input.privateState, { data: { root: "/old" } });
  privateState.legacyRoot = function(this: typeof privateState) { return this.data.root; };
  privateState.supersededRoots = function(env) { return [this.legacyRoot(env)]; };
  const filesystemHost = Object.assign(input.filesystemHost, { owner: "old" });
  filesystemHost.runtimeOwnerKey = function(this: typeof filesystemHost) { return this.owner; };
  filesystemHost.runtimeLockParent = function() { return `/tmp/${this.runtimeOwnerKey()}`; };
  input.boardHost.moveAsideHelp = function() { return String(this.sameResolvedPath("A", "a")); };
  const captured = snapshotRuntimeOptions(input);
  host.comparisonKey = () => "changed";
  host.data.suffix = "changed";
  privateState.legacyRoot = () => "/changed";
  privateState.data.root = "/changed";
  filesystemHost.runtimeOwnerKey = () => "changed";
  filesystemHost.owner = "changed";
  input.boardHost.sameResolvedPath = () => true;
  runWithRuntime(captured, () => {
    assert.equal(currentHost().sameResolvedPath("A", "a"), false);
    assert.equal(currentHost().comparisonKey("x"), "x:old");
    assert.deepEqual(currentPrivateStateHost().supersededRoots(currentPrivateStateHost().environment()), ["/old"]);
    assert.equal(captured.filesystemHost!.runtimeLockParent(), "/tmp/old");
    assert.equal(captured.boardHost!.moveAsideHelp("", ""), "false");
  });
  for (const policy of [host, privateState, filesystemHost, input.boardHost, host.data, privateState.data]) {
    assert.equal(Object.isFrozen(policy), false);
  }
});

test("MCP list/open and retained backend/authorization callbacks keep construction context outside A and under B", async (t) => {
  const { createCatalogMcpWorkspaceResolver } = await import("../src/mcp-workspace-resolver.js");
  const { addCatalogEntry } = await import("../src/catalog.js");
  const home = await realpath(await mkdtemp(join(tmpdir(), "superbee-mcp-capture-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const seen: string[] = [];
  function context(label: string) {
    const input = options(label, seen);
    const resolve = input.privateState.resolvePolicy;
    input.privateState.resolvePolicy = (env) => resolve({ ...env, home: join(home, label) });
    return snapshotRuntimeOptions(input);
  }
  const a = context("A"), b = context("B");
  await runWithRuntime(a, async () => {
    await configuredInitBundle(join(home, "bundle-A"));
    await addCatalogEntry("selected-a", join(home, "bundle-A"), { home });
  });
  await runWithRuntime(b, async () => {
    await configuredInitBundle(join(home, "bundle-B"));
    await addCatalogEntry("selected-b", join(home, "bundle-B"), { home });
  });
  const resolver = runWithRuntime(a, () => createCatalogMcpWorkspaceResolver({ home }));
  const subject = {
    sourceKind: "registered" as const, registryId: "views/test", contentVersion: "sha256:test",
    contentType: "text/html; charset=utf-8" as const, capability: "bundle-read" as const,
    execution: "active" as const, policyVersion: "active-view-v1" as const,
  };
  for (const invoke of [<T>(fn: () => T) => fn(), <T>(fn: () => T) => runWithRuntime(b, fn)]) {
    seen.length = 0;
    const listed = await invoke(() => resolver.list());
    assert.deepEqual(listed.map((entry) => entry.label), ["selected-a"]);
    const selected = await invoke(() => resolver.open("selected-a"));
    assert.equal(selected.bundle.root.endsWith("bundle-A"), true);
    assert.ok(selected.bundle.backend);
    seen.length = 0;
    await invoke(() => selected.bundle.backend!.write("captured", {
      id: "captured", frontmatter: { type: "Note" }, body: "A",
    }));
    assert.ok(seen.includes("A:lock"), "retained backend uses A's lock policy");
    seen.length = 0;
    await invoke(() => selected.viewAuthorization!.authorize(subject));
    assert.ok(seen.includes("A"), "authorization writes use A's private-state policy");
    assert.equal(seen.some((value) => value.startsWith("B")), false);
    seen.length = 0;
    assert.equal(await invoke(() => selected.viewAuthorization!.isAuthorized(subject)), true);
    assert.ok(seen.includes("A"), "authorization reads use A's private-state policy");
    assert.equal(seen.some((value) => value.startsWith("B")), false);
  }
  const selectedB = await runWithRuntime(b, () => createCatalogMcpWorkspaceResolver({ home }).open("selected-b"));
  assert.equal(await selectedB.viewAuthorization!.isAuthorized(subject), false);
});

test("a callback created without a runtime does not inherit a later caller's policy", () => {
  const callback = captureRuntimeCallback(() => currentHost().renderShellToken("x"));
  const expected = callback();
  const b = snapshotRuntimeOptions(options("B", []));
  assert.equal(runWithRuntime(b, callback), expected);
});

test("deferred board attribution retains the constructing private-state context", async (t) => {
  const { boardPostPersistHook } = await import("../src/board-attribution.js");
  const { defaultSyncStore } = await import("../src/cursor.js");
  const a = snapshotRuntimeOptions(options("A", []));
  const b = snapshotRuntimeOptions(options("B", []));
  const seen: string[] = [];
  t.mock.method(defaultSyncStore, "recordSelfActors", async () => {
    seen.push(currentHost().renderShellToken("actor")!);
  });
  const hook = runWithRuntime(a, () => boardPostPersistHook({ kind: "board", stateKey: "selected" }, "human:test"));
  assert.ok(hook);
  await hook();
  await runWithRuntime(b, hook);
  assert.deepEqual(seen, ["A:actor", "A:actor"]);
});

test("a retained remote backend renders transport failure hints under its constructing host", async (t) => {
  const { openBundle } = await import("../src/bundle.js");
  const a = options("A", []), b = options("B", []);
  const seen: string[] = [];
  for (const [input, label] of [[a, "A"], [b, "B"]] as const) {
    input.host.executableCandidates = () => { seen.push(label); return []; };
  }
  const ca = snapshotRuntimeOptions(a), cb = snapshotRuntimeOptions(b);
  const remote = await runWithRuntime(ca, () => openBundle(undefined, "http://127.0.0.1:1"));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("synthetic transport failure"); });
  for (const invoke of [<T>(fn: () => T) => fn(), <T>(fn: () => T) => runWithRuntime(cb, fn)]) {
    seen.length = 0;
    await assert.rejects(invoke(() => remote.backend!.read("missing")), /could not reach the remote bundle/);
    assert.ok(seen.includes("A"));
    assert.equal(seen.includes("B"), false);
  }
});
