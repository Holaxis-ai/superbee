import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { classifyPersistentInstallAuthority } from "../src/install-authority.js";

function durableFixture(overrides: Record<string, unknown> = {}) {
  const prefix = (overrides.prefix as string | undefined) ?? "/opt/superbee-npm";
  const packageRoot = (overrides.packageRoot as string | undefined) ?? "superbee";
  const command = (overrides.command as string | undefined) ?? "superbee";
  const executable = `${prefix}/lib/node_modules/${packageRoot}/dist/superbee.mjs`;
  const bin = `${prefix}/bin/${command}`;
  const runtime = "/opt/node/bin/node";
  const stableRuntime = `${prefix}/bin/node`;
  const realpaths = new Map<string, string>([
    [prefix, prefix],
    [`${prefix}/bin`, `${prefix}/bin`],
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
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "prefix" && key !== "packageRoot" && key !== "command")),
  };
}

test("npm-package authority requires a supported durable npm-global layout", () => {
  const result = classifyPersistentInstallAuthority(durableFixture());
  assert.equal(result.allowed, true);
  assert.equal(result.state, "durable_global");
  assert.equal(result.evidence.bin_path, "/opt/superbee-npm/bin/superbee");
  assert.equal(result.evidence.npm_prefix, "/opt/superbee-npm");
  assert.equal(result.evidence.runtime_path, "/opt/superbee-npm/bin/node");
});

test("durable authority canonicalizes a symlinked npm prefix before comparing its PATH bin", () => {
  const lexical = "/tmp/superbee-prefix";
  const canonical = "/private/tmp/superbee-prefix";
  const lexicalExecutable = `${lexical}/lib/node_modules/superbee/dist/superbee.mjs`;
  const canonicalExecutable = `${canonical}/lib/node_modules/superbee/dist/superbee.mjs`;
  const runtime = "/opt/node/bin/node";
  const result = classifyPersistentInstallAuthority({
    artifact_channel: "npm-package",
    executable_path: lexicalExecutable,
    runtime_path: runtime,
    env: { PATH: `${lexical}/bin:/usr/bin` },
    platform: "darwin",
    npm_prefix_global: () => lexical,
    realpath: (candidate: string) => {
      const normalized = path.normalize(candidate);
      if (normalized === lexical) return canonical;
      if (normalized === `${lexical}/bin` || normalized === `${canonical}/bin`) return `${canonical}/bin`;
      if (normalized === `${lexical}/bin/superbee`) return canonicalExecutable;
      if (normalized === lexicalExecutable || normalized === canonicalExecutable) return canonicalExecutable;
      if (normalized === runtime || normalized === `${canonical}/bin/node`) return runtime;
      return undefined;
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.evidence.bin_path, `${canonical}/bin/superbee`);
  assert.equal(result.evidence.executable_path, canonicalExecutable);
  assert.equal(result.evidence.runtime_path, `${canonical}/bin/node`);
});

test("renamed bridge package bytes can authorize legacy-bin persistent hook writes", () => {
  const result = classifyPersistentInstallAuthority(
    durableFixture({
      prefix: "/opt/aslite-npm",
      packageRoot: "@holaxis/aslite",
      command: "aslite",
    }),
  );
  assert.equal(result.allowed, true);
  assert.equal(result.state, "durable_global");
  assert.equal(result.evidence.bin_path, "/opt/aslite-npm/bin/aslite");
  assert.equal(result.evidence.npm_prefix, "/opt/aslite-npm");
  assert.equal(result.evidence.runtime_path, "/opt/aslite-npm/bin/node");
});

test("legacy ASLite package bytes cannot authorize new persistent hook writes", () => {
  const prefix = "/opt/aslite-npm";
  const executable = `${prefix}/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs`;
  const runtime = "/opt/node/bin/node";
  const stableRuntime = `${prefix}/bin/node`;
  const result = classifyPersistentInstallAuthority({
    artifact_channel: "npm-package",
    executable_path: executable,
    runtime_path: runtime,
    env: { PATH: `${prefix}/bin:/usr/bin` },
    platform: "linux",
    npm_prefix_global: () => prefix,
    realpath: (candidate: string) => {
      const normalized = path.normalize(candidate);
      if (normalized === prefix) return prefix;
      if (normalized === `${prefix}/bin/aslite`) return executable;
      if (normalized === executable) return executable;
      if (normalized === runtime || normalized === stableRuntime) return runtime;
      return undefined;
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.state, "unknown");
});

test("durable npm-package proof fails closed for every missing or transient fact", () => {
  const shadowed = durableFixture({
    env: { PATH: "/tmp/shadow:/opt/superbee-npm/bin" },
    realpath: (candidate: string) => {
      if (candidate === "/opt/superbee-npm") return candidate;
      if (candidate === "/tmp/shadow/superbee") return "/tmp/foreign.mjs";
      if (candidate === "/opt/superbee-npm/bin/superbee") {
        return "/opt/superbee-npm/lib/node_modules/superbee/dist/superbee.mjs";
      }
      if (candidate.endsWith("/dist/superbee.mjs")) return candidate;
      return undefined;
    },
  });
  const cases = [
    durableFixture({ platform: "win32" }),
    durableFixture({ npm_prefix_global: () => undefined }),
    durableFixture({ npm_prefix_global: () => "relative/prefix" }),
    durableFixture({ env: { PATH: "/usr/bin" } }),
    durableFixture({ env: { PATH: "/opt/superbee-npm/bin", npm_command: "exec" } }),
    durableFixture({ env: { PATH: "/opt/superbee-npm/bin", npm_lifecycle_event: "npx" } }),
    durableFixture({ executable_path: "/tmp/_npx/123/node_modules/superbee/dist/superbee.mjs" }),
    durableFixture({ runtime_path: null }),
    durableFixture({
      realpath: (candidate: string) => {
        const normalized = path.normalize(candidate);
        if (normalized === "/opt/superbee-npm") return normalized;
        if (normalized === "/opt/superbee-npm/bin/superbee") {
          return "/opt/superbee-npm/lib/node_modules/superbee/dist/superbee.mjs";
        }
        if (normalized.endsWith("/dist/superbee.mjs")) return normalized;
        if (normalized === "/opt/node/bin/node") return normalized;
        if (normalized === "/opt/superbee-npm/bin/node") return "/opt/other-node/bin/node";
        return undefined;
      },
    }),
    durableFixture({
      executable_path: "/tmp/copied-superbee.mjs",
      realpath: (candidate: string) =>
        candidate === "/opt/superbee-npm" ? candidate : "/tmp/copied-superbee.mjs",
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

test("a package-only npm prefix is a typed runtime-layout failure, not a generic reinstall case", () => {
  const fixture = durableFixture();
  const result = classifyPersistentInstallAuthority({
    ...fixture,
    realpath: (candidate: string) => {
      const normalized = path.normalize(candidate);
      if (normalized === "/opt/superbee-npm/bin/node") return undefined;
      return fixture.realpath(normalized);
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, "unknown");
  assert.equal(result.failure, "npm_prefix_runtime_unavailable");
  assert.match(result.reason, /npm global prefix.*running Node launcher/);
});

test("local-dev policy remains explicit while unknown fails closed", () => {
  const installedLocalDev = classifyPersistentInstallAuthority({
    ...durableFixture(),
    artifact_channel: "local-dev",
  });
  assert.equal(installedLocalDev.allowed, true);
  assert.equal(installedLocalDev.state, "local_dev");
  assert.deepEqual(installedLocalDev.evidence, {
    npm_prefix: "/opt/superbee-npm",
    bin_path: "/opt/superbee-npm/bin/superbee",
    executable_path: "/opt/superbee-npm/lib/node_modules/superbee/dist/superbee.mjs",
    runtime_path: "/opt/superbee-npm/bin/node",
  });

  const repoExecutable = "/workspace/superbee/packages/cli/dist/superbee.mjs";
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
      if (normalized === "/opt/superbee-npm/bin/node") return "/opt/other-node/bin/node";
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
