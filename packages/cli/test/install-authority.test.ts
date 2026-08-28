import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { classifyPersistentInstallAuthority, npmPrefixInvocation } from "../src/install-authority.js";

test("npm-global prefix probing uses the native executable contract", () => {
  assert.deepEqual(npmPrefixInvocation("linux", {}), {
    command: "npm",
    args: ["prefix", "--global"],
  });
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const npm = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  const resolve = (candidate: string) => {
    if (path.win32.normalize(candidate).toLowerCase() === node.toLowerCase()) return node;
    if (path.win32.normalize(candidate).toLowerCase() === npm.toLowerCase()) return npm;
    return undefined;
  };
  assert.deepEqual(npmPrefixInvocation("win32", {
    PATH: String.raw`C:\Program Files\nodejs;C:\Windows\System32`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  }, resolve, node), {
    command: node,
    args: [npm, "prefix", "--global"],
  });
  assert.equal(npmPrefixInvocation("win32", {}, resolve, String.raw`C:\missing\node.exe`), undefined);
});

test("Windows npm-prefix probing binds npm to the running Node installation, not PATH", () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const npmCli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  const foreign = String.raw`C:\foreign\npm.cmd`;
  const calls: string[] = [];
  const resolve = (candidate: string) => {
    calls.push(candidate);
    const normalized = path.win32.normalize(candidate).toLowerCase();
    if (normalized === node.toLowerCase()) return node;
    if (normalized === npmCli.toLowerCase()) return npmCli;
    if (normalized === foreign.toLowerCase()) return foreign;
    return undefined;
  };
  const safe = npmPrefixInvocation("win32", {
    PATH: String.raw`;C:\foreign;C:\Program Files\nodejs`,
    PATHEXT: ".CMD;.EXE",
  }, resolve, node);
  assert.deepEqual(safe, { command: node, args: [npmCli, "prefix", "--global"] });
  assert.equal(calls.includes(foreign), false, "foreign npm.cmd is never resolved or executed");
  assert.equal(calls.some((candidate) => candidate.toLowerCase().endsWith("npm.cmd")), false);
});

test("Windows npm-prefix probing fails closed for missing or ambiguous runtime layouts", () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const npmCli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  const foreignNpmCli = String.raw`D:\foreign\npm-cli.js`;
  const resolveNodeOnly = (candidate: string) => path.win32.normalize(candidate).toLowerCase() === node.toLowerCase()
    ? node
    : undefined;
  assert.equal(npmPrefixInvocation("win32", {}, resolveNodeOnly, node), undefined, "missing npm CLI");
  assert.equal(npmPrefixInvocation("win32", {}, () => undefined, node), undefined, "missing runtime");
  assert.equal(npmPrefixInvocation("win32", {}, resolveNodeOnly, "node.exe"), undefined, "relative runtime");
  assert.equal(npmPrefixInvocation("win32", {}, resolveNodeOnly, String.raw`C:\Program Files\nodejs\node2.exe`), undefined, "unexpected runtime identity");
  assert.equal(npmPrefixInvocation("win32", {}, (candidate) => {
    const normalized = path.win32.normalize(candidate).toLowerCase();
    if (normalized === node.toLowerCase()) return node;
    if (normalized === npmCli.toLowerCase()) return foreignNpmCli;
    return undefined;
  }, node), undefined, "npm CLI escaping the proven runtime installation");
});

test("Windows npm-prefix probing rejects npx cache segments case-insensitively", () => {
  for (const segment of ["_npx", "_NPX", "_NpX"]) {
    const runtime = path.win32.join(String.raw`C:\Users\mike\AppData\Local\npm-cache`, segment, "1", "node.exe");
    assert.equal(
      npmPrefixInvocation("win32", {}, (candidate) => candidate, runtime),
      undefined,
      segment,
    );
  }
});

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
    realpath: (candidate: string) => realpaths.get(path.posix.normalize(candidate)),
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
      const normalized = path.posix.normalize(candidate);
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

test("canonical package bytes cannot authorize through a legacy alias", () => {
  const result = classifyPersistentInstallAuthority(durableFixture({ command: "aslite" }));
  assert.equal(result.allowed, false);
  assert.equal(result.state, "unknown");
  assert.match(result.reason, /no managed PATH bin/);
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
      const normalized = path.posix.normalize(candidate);
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
    durableFixture({ platform: "freebsd" }),
    durableFixture({ npm_prefix_global: () => undefined }),
    durableFixture({ npm_prefix_global: () => "relative/prefix" }),
    durableFixture({ env: { PATH: "/usr/bin" } }),
    durableFixture({ env: { PATH: "/opt/superbee-npm/bin", npm_command: "exec" } }),
    durableFixture({ env: { PATH: "/opt/superbee-npm/bin", npm_lifecycle_event: "npx" } }),
    durableFixture({ executable_path: "/tmp/_npx/123/node_modules/superbee/dist/superbee.mjs" }),
    durableFixture({ runtime_path: null }),
    durableFixture({
      realpath: (candidate: string) => {
        const normalized = path.posix.normalize(candidate);
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
      const normalized = path.posix.normalize(candidate);
      if (normalized === "/opt/superbee-npm/bin/node") return undefined;
      return fixture.realpath(normalized);
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, "unknown");
  assert.equal(result.failure, "npm_prefix_runtime_unavailable");
  assert.match(result.reason, /npm global prefix.*running Node launcher/);
});

function windowsDurableFixture(overrides: Record<string, unknown> = {}) {
  const prefix = (overrides.prefix as string | undefined) ?? String.raw`C:\Users\mike\AppData\Roaming\npm`;
  const packageRoot = (overrides.packageRoot as string | undefined) ?? "superbee";
  const command = (overrides.command as string | undefined) ?? "superbee";
  const executable = path.win32.join(prefix, "node_modules", ...packageRoot.split("/"), "dist", "superbee.mjs");
  const shim = path.win32.join(prefix, `${command}.cmd`);
  const runtime = String.raw`C:\Program Files\nodejs\node.exe`;
  const entries = new Map<string, string>([
    [path.win32.normalize(prefix).toLowerCase(), path.win32.normalize(prefix)],
    [path.win32.normalize(shim).toLowerCase(), path.win32.normalize(shim)],
    [path.win32.normalize(executable).toLowerCase(), path.win32.normalize(executable)],
    [path.win32.normalize(runtime).toLowerCase(), path.win32.normalize(runtime)],
  ]);
  return {
    artifact_channel: "npm-package" as const,
    executable_path: executable,
    runtime_path: runtime,
    env: { PATH: `${prefix};C:\\Windows\\System32`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    npm_prefix_global: () => prefix,
    realpath: (candidate: string) => entries.get(path.win32.normalize(candidate).toLowerCase()),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["prefix", "packageRoot", "command"].includes(key))),
  };
}

test("Windows npm authority proves the prefix shim but launches absolute Node plus package entry", () => {
  const result = classifyPersistentInstallAuthority(windowsDurableFixture());
  assert.equal(result.allowed, true);
  assert.equal(result.state, "durable_global");
  assert.deepEqual(result.evidence, {
    npm_prefix: String.raw`C:\Users\mike\AppData\Roaming\npm`,
    bin_path: String.raw`C:\Users\mike\AppData\Roaming\npm\superbee.cmd`,
    executable_path: String.raw`C:\Users\mike\AppData\Roaming\npm\node_modules\superbee\dist\superbee.mjs`,
    runtime_path: String.raw`C:\Program Files\nodejs\node.exe`,
  });
});

test("Windows npm authority fails closed on cwd-bearing PATH entries", () => {
  const fixture = windowsDurableFixture();
  for (const PATH of [
    String.raw`;C:\Users\mike\AppData\Roaming\npm`,
    String.raw`C:\Users\mike\AppData\Roaming\npm;`,
    String.raw`C:\Users\mike\AppData\Roaming\npm;;C:\Windows\System32`,
  ]) {
    const result = classifyPersistentInstallAuthority({ ...fixture, env: { ...fixture.env, PATH } });
    assert.equal(result.allowed, false, PATH);
    assert.match(result.reason, /current-directory PATH entry/);
  }
});

test("Windows npm authority honors PATHEXT order and refuses an earlier shadowing command", () => {
  const fixture = windowsDurableFixture();
  const shadow = String.raw`C:\foreign\superbee.exe`;
  const result = classifyPersistentInstallAuthority({
    ...fixture,
    env: { ...fixture.env, PATH: String.raw`C:\foreign;C:\Users\mike\AppData\Roaming\npm` },
    realpath: (candidate) => path.win32.normalize(candidate).toLowerCase() === shadow.toLowerCase()
      ? shadow
      : fixture.realpath(candidate),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no managed PATH bin/);
});

test("Windows canonical package authority cannot be rescued by a later stale legacy alias", () => {
  const fixture = windowsDurableFixture();
  const shadow = String.raw`C:\foreign\superbee.exe`;
  const staleAlias = String.raw`C:\Users\mike\AppData\Roaming\npm\aslite.cmd`;
  const result = classifyPersistentInstallAuthority({
    ...fixture,
    env: { ...fixture.env, PATH: String.raw`C:\foreign;C:\Users\mike\AppData\Roaming\npm` },
    realpath: (candidate) => {
      const normalized = path.win32.normalize(candidate);
      if (normalized.toLowerCase() === shadow.toLowerCase()) return shadow;
      if (normalized.toLowerCase() === staleAlias.toLowerCase()) return staleAlias;
      return fixture.realpath(candidate);
    },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no managed PATH bin/);
});

test("Windows npm authority rejects transient and non-shim layouts", () => {
  const fixture = windowsDurableFixture();
  const cases = [
    { ...fixture, env: { ...fixture.env, npm_command: "exec" } },
    { ...fixture, executable_path: String.raw`C:\Users\mike\AppData\Local\npm-cache\_npx\1\node_modules\superbee\dist\superbee.mjs` },
    { ...fixture, runtime_path: String.raw`C:\Users\mike\AppData\Local\npm-cache\_npx\1\node.exe` },
    { ...fixture, npm_prefix_global: () => "relative" },
    { ...fixture, realpath: (candidate: string) => candidate.toLowerCase().endsWith("superbee.cmd") ? undefined : fixture.realpath(candidate) },
  ];
  for (const candidate of cases) assert.equal(classifyPersistentInstallAuthority(candidate).allowed, false);
});

test("Windows npm authority rejects npx cache segments case-insensitively", () => {
  const fixture = windowsDurableFixture();
  for (const segment of ["_npx", "_NPX", "_NpX"]) {
    const cache = path.win32.join(String.raw`C:\Users\mike\AppData\Local\npm-cache`, segment, "1");
    const executableResult = classifyPersistentInstallAuthority({
      ...fixture,
      executable_path: path.win32.join(cache, "node_modules", "superbee", "dist", "superbee.mjs"),
    });
    assert.equal(executableResult.allowed, false, `executable ${segment}`);
    assert.match(executableResult.reason, /npx cache/, segment);

    const runtimeResult = classifyPersistentInstallAuthority({
      ...fixture,
      runtime_path: path.win32.join(cache, "node.exe"),
    });
    assert.equal(runtimeResult.allowed, false, `runtime ${segment}`);
    assert.match(runtimeResult.reason, /transient/, segment);
  }
});

test("POSIX npx cache detection preserves case-sensitive path semantics", () => {
  assert.equal(
    classifyPersistentInstallAuthority(durableFixture({ prefix: "/opt/_npx/superbee-npm" })).allowed,
    false,
  );
  for (const segment of ["_NPX", "_NpX"]) {
    assert.equal(
      classifyPersistentInstallAuthority(durableFixture({ prefix: `/opt/${segment}/superbee-npm` })).allowed,
      true,
      segment,
    );
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
      const normalized = path.posix.normalize(candidate);
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
