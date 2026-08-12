import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { classifyPersistentInstallAuthority } from "../src/install-authority.js";

function durableFixture(overrides: Record<string, unknown> = {}) {
  const prefix = "/opt/aslite-npm";
  const executable = `${prefix}/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs`;
  const bin = `${prefix}/bin/aslite`;
  const runtime = "/opt/node/bin/node";
  const stableRuntime = `${prefix}/bin/node`;
  const realpaths = new Map<string, string>([
    [prefix, prefix],
    [bin, executable],
    [executable, executable],
    [runtime, runtime],
    [stableRuntime, runtime],
  ]);
  return {
    artifact_channel: "npm-package" as const,
    executable_path: executable,
    runtime_path: runtime,
    env: { PATH: `${prefix}/bin:/usr/bin` },
    platform: "linux",
    npm_prefix_global: () => prefix,
    realpath: (candidate: string) => realpaths.get(path.normalize(candidate)),
    ...overrides,
  };
}

test("npm-package authority requires a supported durable npm-global layout", () => {
  const result = classifyPersistentInstallAuthority(durableFixture());
  assert.equal(result.allowed, true);
  assert.equal(result.state, "durable_global");
  assert.equal(result.evidence.bin_path, "/opt/aslite-npm/bin/aslite");
  assert.equal(result.evidence.npm_prefix, "/opt/aslite-npm");
  assert.equal(result.evidence.runtime_path, "/opt/aslite-npm/bin/node");
});

test("durable npm-package proof fails closed for every missing or transient fact", () => {
  const shadowed = durableFixture({
    env: { PATH: "/tmp/shadow:/opt/aslite-npm/bin" },
    realpath: (candidate: string) => {
      if (candidate === "/opt/aslite-npm") return candidate;
      if (candidate === "/tmp/shadow/aslite") return "/tmp/foreign.mjs";
      if (candidate === "/opt/aslite-npm/bin/aslite") {
        return "/opt/aslite-npm/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs";
      }
      if (candidate.endsWith("/dist/agentstate-lite.mjs")) return candidate;
      return undefined;
    },
  });
  const cases = [
    durableFixture({ platform: "win32" }),
    durableFixture({ npm_prefix_global: () => undefined }),
    durableFixture({ npm_prefix_global: () => "relative/prefix" }),
    durableFixture({ env: { PATH: "/usr/bin" } }),
    durableFixture({ env: { PATH: "/opt/aslite-npm/bin", npm_command: "exec" } }),
    durableFixture({ env: { PATH: "/opt/aslite-npm/bin", npm_lifecycle_event: "npx" } }),
    durableFixture({ executable_path: "/tmp/_npx/123/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs" }),
    durableFixture({ runtime_path: null }),
    durableFixture({
      realpath: (candidate: string) => {
        const normalized = path.normalize(candidate);
        if (normalized === "/opt/aslite-npm") return normalized;
        if (normalized === "/opt/aslite-npm/bin/aslite") {
          return "/opt/aslite-npm/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs";
        }
        if (normalized.endsWith("/dist/agentstate-lite.mjs")) return normalized;
        if (normalized === "/opt/node/bin/node") return normalized;
        if (normalized === "/opt/aslite-npm/bin/node") return "/opt/other-node/bin/node";
        return undefined;
      },
    }),
    durableFixture({
      executable_path: "/tmp/copied-agentstate-lite.mjs",
      realpath: (candidate: string) =>
        candidate === "/opt/aslite-npm" ? candidate : "/tmp/copied-agentstate-lite.mjs",
    }),
    shadowed,
  ];
  for (const fixture of cases) {
    const result = classifyPersistentInstallAuthority(fixture as never);
    assert.equal(result.allowed, false);
    assert.equal(result.state, "unknown");
    assert.ok(result.reason.length > 0);
  }
});

test("local-dev policy remains explicit while unknown fails closed", () => {
  const installedLocalDev = classifyPersistentInstallAuthority({
    ...durableFixture(),
    artifact_channel: "local-dev",
  });
  assert.equal(installedLocalDev.allowed, true);
  assert.equal(installedLocalDev.state, "local_dev");
  assert.deepEqual(installedLocalDev.evidence, {
    npm_prefix: "/opt/aslite-npm",
    bin_path: "/opt/aslite-npm/bin/aslite",
    executable_path: "/opt/aslite-npm/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs",
    runtime_path: "/opt/aslite-npm/bin/node",
  });

  const repoExecutable = "/workspace/agentstate-lite/packages/cli/dist/agentstate-lite.mjs";
  let npmPrefixCalls = 0;
  assert.deepEqual(
    classifyPersistentInstallAuthority({
      ...durableFixture(),
      artifact_channel: "local-dev",
      executable_path: repoExecutable,
      npm_prefix_global: () => {
        npmPrefixCalls += 1;
        return "/should/not/be/read";
      },
    }),
    {
      allowed: true,
      state: "local_dev",
      reason: "developer build",
      evidence: {
        npm_prefix: null,
        bin_path: null,
        executable_path: repoExecutable,
        runtime_path: durableFixture().runtime_path,
      },
    },
  );
  assert.equal(npmPrefixCalls, 0, "repository local-dev must not probe npm-global authority");

  const refusedInstalledLocalDev = classifyPersistentInstallAuthority({
    ...durableFixture(),
    artifact_channel: "local-dev",
    realpath: (candidate: string) => {
      const normalized = path.normalize(candidate);
      if (normalized === "/opt/aslite-npm/bin/node") return "/opt/other-node/bin/node";
      return durableFixture().realpath(normalized);
    },
  });
  assert.equal(refusedInstalledLocalDev.allowed, false);
  assert.equal(refusedInstalledLocalDev.state, "unknown");

  assert.equal(
    classifyPersistentInstallAuthority({ ...durableFixture(), artifact_channel: "unknown" }).allowed,
    false,
  );
});
