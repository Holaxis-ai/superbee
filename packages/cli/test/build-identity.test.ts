import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUILD_IDENTITY_SCHEMA,
  buildIdentityEnvelope,
  parseBakedBuildIdentity,
  resolveBakedBuildIdentity,
  staticBuildIdentity,
} from "../src/build-identity.js";

const VALID_BAKED = {
  schema: BUILD_IDENTITY_SCHEMA,
  package: { name: "superbee", version: "0.1.0-pre.2" },
  source: { commit: "0123456789012345678901234567890123456789", dirty: false },
  artifact: { channel: "npm-package" },
  compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
};

test("baked identity accepts the normative schema and malformed input fails closed", () => {
  assert.deepEqual(parseBakedBuildIdentity(VALID_BAKED), VALID_BAKED);
  assert.equal(parseBakedBuildIdentity({ ...VALID_BAKED, schema: "future" }), null);
  assert.equal(parseBakedBuildIdentity({ ...VALID_BAKED, package: { version: "9.9.9" } }), null);
  assert.equal(
    parseBakedBuildIdentity({ ...VALID_BAKED, package: { name: "Invalid Package", version: "9.9.9" } }),
    null,
  );
  assert.equal(parseBakedBuildIdentity({ ...VALID_BAKED, artifact: { channel: "latest" } }), null);

  const renamed = {
    ...VALID_BAKED,
    package: { name: "@holaxis/renamed", version: VALID_BAKED.package.version },
  };
  assert.deepEqual(parseBakedBuildIdentity(renamed), renamed);

  const failed = resolveBakedBuildIdentity({ ...VALID_BAKED, source: { commit: 42, dirty: "no" } });
  assert.equal(failed.package.version, "unknown");
  assert.deepEqual(failed.source, { commit: null, dirty: null });
  assert.equal(failed.artifact.channel, "unknown");
  assert.deepEqual(failed.compatibility_contracts, { skill: null, hook: null, mcp: null });
});

test("an unbundled source run is explicitly local-dev with unknown source-control facts", () => {
  const identity = staticBuildIdentity();
  assert.equal(identity.artifact.channel, "local-dev");
  assert.deepEqual(identity.source, { commit: null, dirty: null });
  assert.equal(identity.package.name, "superbee");
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(Object.isFrozen(identity.package), true);
});

test("runtime evidence distinguishes global PATH, probable npx, direct, source, and unknown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-runtime-identity-"));
  try {
    const executable = path.join(dir, "superbee.mjs");
    const source = path.join(dir, "entry.ts");
    writeFileSync(executable, "#!/usr/bin/env node\n");
    writeFileSync(source, "// source\n");
    const base = {
      executablePath: () => executable,
      invocation: () => "aslite",
      managedBin: () => "aslite",
      argv: ["node", executable],
      env: {},
    } as const;

    const global = buildIdentityEnvelope(base);
    assert.equal(global.identity.runtime.launch_mode, "path");
    assert.equal(global.identity.runtime.launch_confidence, "certain");
    assert.match(global.identity.artifact.sha256 ?? "", /^sha256:[a-f0-9]{64}$/);

    const npmSubprocessOnPath = buildIdentityEnvelope({ ...base, env: { npm_command: "exec" } });
    assert.equal(npmSubprocessOnPath.identity.runtime.launch_mode, "path");
    assert.equal(npmSubprocessOnPath.identity.runtime.launch_confidence, "certain");

    const npxDir = path.join(dir, "_npx", "cache", "node_modules", ".bin");
    const npxExecutable = path.join(npxDir, "superbee.mjs");
    mkdirSync(npxDir, { recursive: true });
    writeFileSync(npxExecutable, "#!/usr/bin/env node\n");
    const cacheNpx = buildIdentityEnvelope({
      ...base,
      executablePath: () => npxExecutable,
      argv: ["node", path.join(dir, "npm-cli.js")],
      env: { npm_command: "exec" },
    });
    assert.equal(cacheNpx.identity.runtime.launch_mode, "npx-inferred");
    assert.equal(cacheNpx.identity.runtime.launch_confidence, "inferred");

    const direct = buildIdentityEnvelope({ ...base, managedBin: () => undefined });
    assert.equal(direct.identity.runtime.launch_mode, "direct");
    assert.equal(direct.identity.runtime.launch_confidence, "certain");

    const npmEnvironmentOnly = buildIdentityEnvelope({
      ...base,
      managedBin: () => undefined,
      argv: ["node", path.join(dir, "npm-cli.js")],
      env: { npm_command: "exec" },
    });
    assert.equal(npmEnvironmentOnly.identity.runtime.launch_mode, "npx-inferred");
    assert.equal(npmEnvironmentOnly.identity.runtime.launch_confidence, "inferred");

    const sourceRun = buildIdentityEnvelope({
      ...base,
      executablePath: () => source,
      managedBin: () => undefined,
      argv: ["node", path.join(dir, "test-runner.mjs")],
    });
    assert.equal(sourceRun.identity.runtime.launch_mode, "source");
    assert.equal(sourceRun.identity.runtime.launch_confidence, "inferred");

    const misleadingSourceDir = path.join(dir, "src");
    const copiedBundle = path.join(misleadingSourceDir, "superbee.mjs");
    mkdirSync(misleadingSourceDir);
    writeFileSync(copiedBundle, "#!/usr/bin/env node\n");
    const copiedDirect = buildIdentityEnvelope({
      ...base,
      executablePath: () => copiedBundle,
      managedBin: () => undefined,
      argv: ["node", copiedBundle],
    });
    assert.equal(copiedDirect.identity.runtime.launch_mode, "direct");
    assert.equal(copiedDirect.identity.runtime.launch_confidence, "certain");

    const unknown = buildIdentityEnvelope({
      ...base,
      executablePath: () => undefined,
      managedBin: () => undefined,
      argv: ["node"],
    });
    assert.equal(unknown.identity.runtime.executable_path, null);
    assert.equal(unknown.identity.artifact.sha256, null);
    assert.equal(unknown.identity.runtime.launch_mode, "unknown");
    assert.equal(unknown.identity.runtime.launch_confidence, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
