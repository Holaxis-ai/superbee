/**
 * `--version` / `-v` print the CLI's own version and exit 0 — NOT the pre-fix "options must follow
 * the command" USAGE error (exit 2). Unit: `cliVersion()` reads the package version (source-run
 * fallback path). Integration: the BUILT bundle prints it. Plugin-channel: a bundle copied to a
 * lone-script layout with NO adjacent package.json STILL prints it — proving the version is baked in
 * at build time (esbuild `define`), not merely read from a neighboring file.
 *
 * Requires the built bundle; the cli `test` script builds (`node build.mjs local-dev`) before running, same as
 * every other integration test here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cliVersion, KNOWN_COMMANDS } from "../src/cli.js";
import { BUILD_IDENTITY_SCHEMA } from "../src/build-identity.js";
import { buildCliBundle } from "../scripts/build-bundle.mjs";
import { COMMAND_GROUPS } from "../src/reference.js";
import { VERSION_USAGE } from "../src/commands/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.resolve(cliPackageRoot, "dist/superbee.mjs");
const pkgVersion = (JSON.parse(readFileSync(path.resolve(cliPackageRoot, "package.json"), "utf8")) as { version: string }).version;

function runCli(executable: string, args: string[]) {
  return spawnSync("node", [executable, ...args], { encoding: "utf8" });
}

function runIdentity(executable: string): Record<string, any> {
  const result = runCli(executable, ["version", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, any>;
}

test("cliVersion() returns the package's own version (never 'unknown')", () => {
  assert.equal(cliVersion(), pkgVersion);
  assert.match(cliVersion(), /^\d+\.\d+\.\d+/); // a real semver, so the fallback never leaked
});

test("version is registered in command discovery", () => {
  assert.ok(KNOWN_COMMANDS.includes("version"));
  assert.ok(
    COMMAND_GROUPS.flatMap((group) => group.commands).some((command) =>
      command.usage.startsWith("version "),
    ),
  );
});

test("version help carries bounded stable-MCP verification guidance", () => {
  assert.match(VERSION_USAGE, /npm install -g superbee/);
  assert.match(VERSION_USAGE, /command `superbee`.*argument `mcp`/s);
  assert.match(VERSION_USAGE, /`superbee version --json`/);
  assert.match(VERSION_USAGE, /does not scan or rewrite host MCP configuration/);
  assert.match(VERSION_USAGE, /--check performs one read-only, two-second comparison/);
  assert.match(VERSION_USAGE, /--tag latest\|next/);
  assert.match(VERSION_USAGE, /never installs a package/);
});

test("the BUILT CLI: `--version` and `-v` print the version and exit 0", () => {
  for (const flag of ["--version", "-v"]) {
    const r = spawnSync("node", [cliBin, flag], { encoding: "utf8" });
    assert.equal(r.status, 0, `${flag} exits 0 (was exit 2 USAGE before this fix)`);
    assert.equal(r.stdout.trim(), pkgVersion, `${flag} prints the version`);
  }
});

test("the BUILT CLI exposes the exact complete envelope in JSON and TOON", () => {
  const envelope = runIdentity(cliBin);
  assert.deepEqual(Object.keys(envelope), ["identity", "drift"]);
  assert.equal(envelope.identity.schema, BUILD_IDENTITY_SCHEMA);
  assert.deepEqual(envelope.identity.package, { name: "superbee", version: pkgVersion });
  assert.equal(envelope.identity.artifact.channel, "local-dev");
  assert.match(envelope.identity.artifact.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(envelope.identity.runtime.executable_path, cliBin);
  assert.ok(["direct", "path"].includes(envelope.identity.runtime.launch_mode));
  assert.deepEqual(envelope.identity.compatibility_contracts, { skill: 1, hook: 1, mcp: 1 });
  assert.deepEqual(envelope.drift, { adjacent_package_version: pkgVersion, version_mismatch: false });

  const toon = runCli(cliBin, ["version"]);
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /schema: superbee\.build-identity\.v1/);
  assert.match(toon.stdout, new RegExp(`version: ${pkgVersion.replaceAll(".", "\\.")}`));
});

test("a real loader-driven source launch identifies and hashes src/index.ts, not an imported helper", () => {
  const sourceEntry = path.resolve(cliPackageRoot, "src/index.ts");
  const loader = path.resolve(cliPackageRoot, "test/ts-loader.mjs");
  const result = spawnSync(
    "node",
    ["--import", loader, sourceEntry, "version", "--json"],
    { cwd: cliPackageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as Record<string, any>;
  const expectedSha = `sha256:${createHash("sha256").update(readFileSync(sourceEntry)).digest("hex")}`;
  assert.equal(envelope.identity.runtime.executable_path, sourceEntry);
  assert.equal(envelope.identity.artifact.sha256, expectedSha);
  assert.equal(envelope.identity.artifact.channel, "local-dev");
  assert.equal(envelope.identity.runtime.launch_mode, "direct");
  assert.equal(envelope.identity.runtime.launch_confidence, "certain");
});

test("a relocated bundle with no adjacent package.json still prints the baked version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-relocated-layout-"));
  try {
    const scriptDir = path.join(dir, "isolated");
    mkdirSync(scriptDir, { recursive: true });
    const stray = path.join(scriptDir, "superbee.mjs");
    copyFileSync(cliBin, stray); // NO package.json anywhere near it
    const r = spawnSync("node", [stray, "--version"], { encoding: "utf8" });
    assert.equal(r.status, 0, "relocated --version exits 0");
    assert.equal(r.stdout.trim(), pkgVersion, "relocated --version prints the baked version, not 'unknown'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale adjacent package manifest is drift evidence, never version authority", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-stale-adjacent-"));
  try {
    const dist = path.join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const executable = path.join(dist, "superbee.mjs");
    copyFileSync(cliBin, executable);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));

    assert.equal(runCli(executable, ["--version"]).stdout.trim(), pkgVersion);
    const envelope = runIdentity(executable);
    assert.equal(envelope.identity.package.version, pkgVersion);
    assert.deepEqual(envelope.drift, {
      adjacent_package_version: "9.9.9",
      version_mismatch: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same version with different bytes cannot present the same complete identity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-byte-identity-"));
  try {
    const original = path.join(dir, "original.mjs");
    const relocated = path.join(dir, "relocated.mjs");
    const changed = path.join(dir, "changed.mjs");
    copyFileSync(cliBin, original);
    copyFileSync(cliBin, relocated);
    copyFileSync(cliBin, changed);
    appendFileSync(changed, "\n// test-only byte change\n");

    const a = runIdentity(original);
    const relocatedIdentity = runIdentity(relocated);
    const changedIdentity = runIdentity(changed);
    assert.equal(a.identity.package.version, pkgVersion);
    assert.equal(changedIdentity.identity.package.version, pkgVersion);
    assert.equal(a.identity.artifact.sha256, relocatedIdentity.identity.artifact.sha256);
    assert.notEqual(a.identity.runtime.executable_path, relocatedIdentity.identity.runtime.executable_path);
    assert.notEqual(a.identity.artifact.sha256, changedIdentity.identity.artifact.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build flavor is mandatory and unsupported distribution channels are rejected", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-build-flavor-"));
  try {
    const missing = path.join(dir, "missing.mjs");
    await assert.rejects(() => buildCliBundle(missing), /requires artifactChannel/);
    await assert.rejects(
      () =>
        buildCliBundle(path.join(dir, "dirty-npm.mjs"), {
          artifactChannel: "npm-package",
          functionalVersionFloor: "0.1.0-pre.11",
          source: { commit: "0123456789012345678901234567890123456789", dirty: true },
        }),
      /npm-package release builds require an exact clean Git source.*Use local-dev for ordinary verification/s,
    );

    await assert.rejects(
      () =>
        buildCliBundle(path.join(dir, "retired-channel.mjs"), {
          artifactChannel: "marketplace-legacy",
          functionalVersionFloor: "0.1.0-pre.11",
          source: { commit: null, dirty: null },
        }),
      /requires artifactChannel: npm-package \| local-dev/,
    );

    for (const functionalVersionFloor of ["01.2.3", "1.02.3", "1.2.3-01", "1.2.3-alpha."]) {
      await assert.rejects(
        () =>
          buildCliBundle(path.join(dir, "malformed-floor.mjs"), {
            artifactChannel: "local-dev",
            functionalVersionFloor,
            source: { commit: null, dirty: null },
          }),
        /requires a strict SemVer functionalVersionFloor/,
        functionalVersionFloor,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
