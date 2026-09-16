import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  classifyPersistentInstallAuthority as classify,
  type PersistentInstallAuthorityInput,
} from "../src/install-authority.js";
import { withTestPolicy } from "./support/host-policy.js";
// Synthetic host facts exercise the SHARED classifier. Concrete shim/PATHEXT algorithms live downstream.
function classifyPersistentInstallAuthority(
  input: PersistentInstallAuthorityInput,
) {
  const paths = path.win32;
  return withTestPolicy(
    {
      host: {
        id: input.platform,
        paths,
        sameResolvedPath: (a, b) =>
          paths.normalize(a).toLowerCase() === paths.normalize(b).toLowerCase(),
        npmGlobalPaths: (prefix, layout) => ({
          executable: paths.join(
            prefix,
            "node_modules",
            ...layout.packageName.split("/"),
            layout.entryRelativePath,
          ),
          binDirectory: prefix,
        }),
        executableCandidates: (dir, name) =>
          [".COM", ".EXE", ".BAT", ".CMD"].map((ext) =>
            paths.join(dir, name + ext),
          ),
        installedBinPath: (prefix, name) => paths.join(prefix, name + ".cmd"),
        binMatches: (candidate, resolved) =>
          candidate.toLowerCase().endsWith(".cmd") &&
          candidate.toLowerCase() === resolved.toLowerCase(),
        stableRuntimePath: (_prefix, runtime) => runtime,
      },
    },
    () => classify(input),
  );
}
function windowsDurableFixture(overrides: Record<string, unknown> = {}) {
  const prefix =
    (overrides.prefix as string | undefined) ??
    String.raw`C:\Users\mike\AppData\Roaming\npm`;
  const packageRoot =
    (overrides.packageRoot as string | undefined) ?? "superbee";
  const command = (overrides.command as string | undefined) ?? "superbee";
  const executable = path.win32.join(
    prefix,
    "node_modules",
    ...packageRoot.split("/"),
    "dist",
    "superbee.mjs",
  );
  const shim = path.win32.join(prefix, `${command}.cmd`);
  const runtime = String.raw`C:\Program Files\nodejs\node.exe`;
  const entries = new Map<string, string>([
    [path.win32.normalize(prefix).toLowerCase(), path.win32.normalize(prefix)],
    [path.win32.normalize(shim).toLowerCase(), path.win32.normalize(shim)],
    [
      path.win32.normalize(executable).toLowerCase(),
      path.win32.normalize(executable),
    ],
    [
      path.win32.normalize(runtime).toLowerCase(),
      path.win32.normalize(runtime),
    ],
  ]);
  return {
    artifact_channel: "npm-package" as const,
    executable_path: executable,
    runtime_path: runtime,
    env: {
      PATH: `${prefix};C:\\Windows\\System32`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
    platform: "win32",
    npm_prefix_global: () => prefix,
    realpath: (candidate: string) =>
      entries.get(path.win32.normalize(candidate).toLowerCase()),
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !["prefix", "packageRoot", "command"].includes(key),
      ),
    ),
  };
}

test("Host-supplied npm authority proves the prefix shim but launches absolute Node plus package entry", () => {
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

test("Host-supplied npm authority fails closed on cwd-bearing PATH entries", () => {
  const fixture = windowsDurableFixture();
  for (const PATH of [
    String.raw`;C:\Users\mike\AppData\Roaming\npm`,
    String.raw`C:\Users\mike\AppData\Roaming\npm;`,
    String.raw`C:\Users\mike\AppData\Roaming\npm;;C:\Windows\System32`,
  ]) {
    const result = classifyPersistentInstallAuthority({
      ...fixture,
      env: { ...fixture.env, PATH },
    });
    assert.equal(result.allowed, false, PATH);
    assert.match(result.reason, /current-directory PATH entry/);
  }
});

test("Host-supplied npm authority honors candidate order and refuses an earlier shadowing command", () => {
  const fixture = windowsDurableFixture();
  const shadow = String.raw`C:\foreign\superbee.exe`;
  const result = classifyPersistentInstallAuthority({
    ...fixture,
    env: {
      ...fixture.env,
      PATH: String.raw`C:\foreign;C:\Users\mike\AppData\Roaming\npm`,
    },
    realpath: (candidate) =>
      path.win32.normalize(candidate).toLowerCase() === shadow.toLowerCase()
        ? shadow
        : fixture.realpath(candidate),
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no managed PATH bin/);
});

test("Canonical package authority cannot be rescued by a later stale legacy alias", () => {
  const fixture = windowsDurableFixture();
  const shadow = String.raw`C:\foreign\superbee.exe`;
  const staleAlias = String.raw`C:\Users\mike\AppData\Roaming\npm\aslite.cmd`;
  const result = classifyPersistentInstallAuthority({
    ...fixture,
    env: {
      ...fixture.env,
      PATH: String.raw`C:\foreign;C:\Users\mike\AppData\Roaming\npm`,
    },
    realpath: (candidate) => {
      const normalized = path.win32.normalize(candidate);
      if (normalized.toLowerCase() === shadow.toLowerCase()) return shadow;
      if (normalized.toLowerCase() === staleAlias.toLowerCase())
        return staleAlias;
      return fixture.realpath(candidate);
    },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /no managed PATH bin/);
});

test("Host-supplied npm authority rejects transient and non-shim layouts", () => {
  const fixture = windowsDurableFixture();
  const cases = [
    { ...fixture, env: { ...fixture.env, npm_command: "exec" } },
    {
      ...fixture,
      executable_path: String.raw`C:\Users\mike\AppData\Local\npm-cache\_npx\1\node_modules\superbee\dist\superbee.mjs`,
    },
    {
      ...fixture,
      runtime_path: String.raw`C:\Users\mike\AppData\Local\npm-cache\_npx\1\node.exe`,
    },
    { ...fixture, npm_prefix_global: () => "relative" },
    {
      ...fixture,
      realpath: (candidate: string) =>
        candidate.toLowerCase().endsWith("superbee.cmd")
          ? undefined
          : fixture.realpath(candidate),
    },
  ];
  for (const candidate of cases)
    assert.equal(classifyPersistentInstallAuthority(candidate).allowed, false);
});
