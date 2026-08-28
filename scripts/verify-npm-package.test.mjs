import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertCommandInBin,
  assertPackageContract,
  assertRetiredDistributionAbsent,
  expectedTarballFiles,
  expectedPrivateStateRoot,
  parseVerificationArgs,
  resolveCommandOnPath,
  sanitizedNpmEnvironment,
  verificationPolicy,
} from "./verify-npm-package.mjs";
import { npmInvocation as uiBuildNpmInvocation } from "../packages/cli/scripts/embed-ui-assets.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const referenceFiles = ["views/pulse.html", "views/references/view-authoring-v0.md"];
const receipt = {
  files: expectedTarballFiles(referenceFiles).map((path) => ({ path })),
};
const manifest = {
  name: "superbee",
  files: ["dist", "SKILL.md", "references", "NOTICE"],
  bin: {
    superbee: "dist/superbee.mjs",
  },
  exports: {
    ".": "./dist/superbee.mjs",
    "./publication": {
      types: "./dist/publication/index.d.ts",
      default: "./dist/publication.mjs",
    },
    "./publication/bridge": {
      types: "./dist/publication/bridge-entry.d.ts",
      default: "./dist/publication-bridge.mjs",
    },
  },
  publishConfig: { access: "public" },
  devDependencies: { local: "*" },
};

test("the Superbee package installs beside Aslite and survives its removal", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-side-by-side-global-"));
  const prefix = path.join(scratch, "prefix");
  const legacyRoot = path.join(scratch, "legacy");
  const successorRoot = path.join(scratch, "successor");
  const npmUserConfig = path.join(scratch, "empty-npmrc");
  const npmCache = path.join(scratch, "npm-cache");
  try {
    await Promise.all([mkdir(legacyRoot), mkdir(successorRoot), writeFile(npmUserConfig, "")]);
    await Promise.all([
      writeFile(
        path.join(legacyRoot, "package.json"),
        `${JSON.stringify({
          name: "@holaxis/aslite",
          version: "0.1.0-pre.11",
          bin: { aslite: "cli.mjs", "agentstate-lite": "cli.mjs" },
        })}\n`,
      ),
      writeFile(path.join(legacyRoot, "cli.mjs"), "#!/usr/bin/env node\nconsole.log('legacy')\n", { mode: 0o755 }),
      writeFile(
        path.join(successorRoot, "package.json"),
        `${JSON.stringify({ name: "superbee", version: "0.1.0", bin: { superbee: "cli.mjs" } })}\n`,
      ),
      writeFile(path.join(successorRoot, "cli.mjs"), "#!/usr/bin/env node\nconsole.log('successor')\n", { mode: 0o755 }),
    ]);
    const env = sanitizedNpmEnvironment(process.env, npmUserConfig, npmCache);
    const npm = (...args) => execFileAsync("npm", args, { cwd: scratch, env });
    const installArgs = ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"];
    await npm(...installArgs, legacyRoot);
    await npm(...installArgs, successorRoot);

    const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    if (process.platform !== "win32") await symlink(process.execPath, path.join(binDir, "node"));
    const commandEnv = { ...env, PATH: binDir };
    for (const command of ["superbee", "aslite", "agentstate-lite"]) {
      await assertCommandInBin(command, commandEnv, binDir);
    }
    assert.equal((await execFileAsync(await resolveCommandOnPath("superbee", commandEnv), [], { env: commandEnv })).stdout.trim(), "successor");
    assert.equal((await execFileAsync(await resolveCommandOnPath("aslite", commandEnv), [], { env: commandEnv })).stdout.trim(), "legacy");

    await npm("uninstall", "--global", "--prefix", prefix, "@holaxis/aslite");
    await assertCommandInBin("superbee", commandEnv, binDir);
    assert.equal(await resolveCommandOnPath("aslite", commandEnv), undefined);
    assert.equal(await resolveCommandOnPath("agentstate-lite", commandEnv), undefined);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the npm verifier rejects every retired marketplace surface", async () => {
  for (const retired of [
    path.join("plugins", "agentstate-lite", "unexpected.txt"),
    path.join(".claude-plugin", "unexpected.txt"),
    path.join(".agents", "plugins", "marketplace.json"),
  ]) {
    const scratch = await mkdtemp(path.join(tmpdir(), "aslite-retired-channel-"));
    try {
      await assertRetiredDistributionAbsent(scratch);
      await mkdir(path.dirname(path.join(scratch, retired)), { recursive: true });
      await writeFile(path.join(scratch, retired), "retired channel returned\n");
      await assert.rejects(
        () => assertRetiredDistributionAbsent(scratch),
        /npm is the sole executable distribution authority/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test("root README teaches the literal create-only quickstart; npm README teaches the agent-first journey", async () => {
  for (const [label, file] of [
    ["root", path.join(repoRoot, "README.md")],
    ["npm", path.join(repoRoot, "packages", "cli", "README.md")],
  ]) {
    const readme = await readFile(file, "utf8");
    assert.match(
      readme,
      /^\s*npm install -g superbee$/m,
      `${label} README must install the supported default package without a preview tag`,
    );
    assert.doesNotMatch(
      readme,
      /^\s*(?:npm install -g|npx -y) superbee@next\b/m,
      `${label} README must not teach the preview tag as the default journey`,
    );
    assert.match(
      readme,
      /npm uninstall -g @holaxis\/aslite/,
      `${label} README must explain when the retired global package can be removed`,
    );
    assert.doesNotMatch(
      readme,
      /^aslite (?:skill|hook) install --scope global\b/m,
      `${label} README must teach the canonical user scope`,
    );
  }

  const rootReadme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.match(
    rootReadme,
    /init --create-only --recipe work-tracking/,
    "root README must use the safe literal work-tracking creation command",
  );
  assert.match(
    rootReadme,
    /bring source material or intent\s+to your agent/i,
    "root README must explain what the user contributes",
  );
  assert.match(
    rootReadme,
    /agent organizes,\s+types, links, and updates the\s+bundle/i,
    "root README must explain the agent's authoring role",
  );
  assert.match(
    rootReadme,
    /`quickstart-agent` is an advisory example actor label; replace it with the actual agent identity\./,
    "root README must explain the tutorial actor label",
  );

  const npmReadme = await readFile(path.join(repoRoot, "packages", "cli", "README.md"), "utf8");
  assert.match(
    npmReadme,
    /ask your AI agent to run `superbee setup`/,
    "npm README must route setup through the agent",
  );
  assert.match(
    npmReadme,
    /ask your agent for what\s+you need/i,
    "npm README must frame usage as asking the agent",
  );
  assert.match(
    npmReadme,
    /translate your\s+instructions into CLI commands/i,
    "npm README must explain the Agent Skill's translation role",
  );
  assert.match(
    npmReadme,
    /Node\.js 20 or newer on macOS, Linux, or Windows/,
    "npm README must advertise every supported native platform",
  );
  assert.doesNotMatch(
    npmReadme,
    /Windows is not supported|EBADPLATFORM|["']!win32["']/i,
    "npm README must not retain the retired Windows package block",
  );
});

test("root and npm package license declarations agree", async () => {
  const [rootManifest, npmManifest, rootReadme, npmReadme] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "packages", "cli", "README.md"), "utf8"),
  ]);

  assert.equal(npmManifest.license, rootManifest.license, "root and npm package manifests must use one license");
  const expectedNotice = `${rootManifest.license} \u00a9 2026 Holaxis`;
  for (const [label, readme] of [
    ["root", rootReadme],
    ["npm", npmReadme],
  ]) {
    assert.equal(
      readme.match(/^## License\n\n([^\n]+)$/m)?.[1],
      expectedNotice,
      `${label} README license notice must agree with package metadata`,
    );
  }
});

test("lockfile workspace metadata preserves the npm package platform contract", async () => {
  const [npmManifest, lockfile] = await Promise.all([
    readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  const locked = lockfile.packages?.["packages/cli"];
  assert.ok(locked, "package-lock must describe the CLI workspace");
  assert.equal(locked.version, npmManifest.version, "lockfile CLI version must match the publish manifest");
  assert.deepEqual(locked.os, npmManifest.os, "lockfile must not retain a stale OS restriction");
  assert.deepEqual(locked.cpu, npmManifest.cpu, "lockfile must not retain a stale CPU restriction");
});

test("the expected tarball set is the fixed base plus the references tree", () => {
  assert.deepEqual(expectedTarballFiles(["a.md", "b/c.md"]), [
    "LICENSE",
    "NOTICE",
    "README.md",
    "SKILL.md",
    "dist/publication-bridge.mjs",
    "dist/publication.mjs",
    "dist/publication/bridge-entry.d.ts",
    "dist/publication/bridge.d.ts",
    "dist/publication/canonical-json.d.ts",
    "dist/publication/capture.d.ts",
    "dist/publication/errors.d.ts",
    "dist/publication/generated/publication-snapshot-v1.d.ts",
    "dist/publication/index.d.ts",
    "dist/publication/schema.d.ts",
    "dist/publication/schema/publication-snapshot-v1.schema.json",
    "dist/publication/snapshot-backend.d.ts",
    "dist/publication/types.d.ts",
    "dist/superbee.mjs",
    "package.json",
    "references/a.md",
    "references/b/c.md",
  ]);
});

test("the package proof projects the platform-native private-state root", () => {
  assert.equal(expectedPrivateStateRoot("/tmp/home", "linux", {}), "/tmp/home/.superbee-state");
  assert.equal(
    expectedPrivateStateRoot("C:\\Users\\proof", "win32", {
      LOCALAPPDATA: String.raw`C:\Users\proof\AppData\Local`,
    }),
    String.raw`C:\Users\proof\AppData\Local\Superbee`,
  );
  assert.throws(
    () => expectedPrivateStateRoot("C:\\Users\\proof", "win32", {}),
    /requires an isolated LOCALAPPDATA/,
  );
});

test("the npm package contract accepts the intended self-contained artifact", () => {
  assert.doesNotThrow(() => assertPackageContract(receipt, manifest, referenceFiles));
});

test("the npm package contract rejects surface and runtime dependency drift", () => {
  assert.throws(
    () =>
      assertPackageContract({ files: [...receipt.files, { path: "src/index.ts" }] }, manifest, referenceFiles),
    /must contain only/,
  );
  assert.throws(
    () => assertPackageContract(receipt, { ...manifest, files: ["dist"] }, referenceFiles),
    /deep-equal/,
  );
  assert.throws(
    () => assertPackageContract(receipt, { ...manifest, dependencies: { pako: "^2" } }, referenceFiles),
    /dependencies must be empty/,
  );
  assert.throws(
    () => assertPackageContract(receipt, { ...manifest, devDependencies: { local: "workspace:*" } }, referenceFiles),
    /workspace: references/,
  );
  // Scoped coordinate: a missing or restricted publishConfig must fail the contract, never
  // silently publish private.
  assert.throws(
    () => assertPackageContract(receipt, { ...manifest, publishConfig: undefined }, referenceFiles),
    /publishConfig\.access must be public/,
  );
  assert.throws(
    () => assertPackageContract(receipt, { ...manifest, publishConfig: { access: "restricted" } }, referenceFiles),
    /publishConfig\.access must be public/,
  );
});

test("the npm package contract rejects an undeclared fourth .mjs artifact even when the file set matches", () => {
  const smuggled = [...referenceFiles, "scripts/helper.mjs"];
  const smuggledReceipt = {
    files: [...receipt.files, { path: "references/scripts/helper.mjs" }],
  };
  assert.throws(
    () => assertPackageContract(smuggledReceipt, manifest, smuggled),
    /declared executable.*publication subpath bundles/,
  );
});

test("npm subprocesses discard inherited lifecycle, workspace, prefix, and bin settings", () => {
  const clean = sanitizedNpmEnvironment(
    {
      PATH: "/runtime/bin",
      npm_execpath: "/npm-cli.js",
      npm_config_dry_run: "true",
      NPM_CONFIG_WORKSPACES: "false",
      npm_config_workspace: "superbee",
      npm_config_prefix: "/wrong-prefix",
      npm_config_bin_links: "false",
    },
    "/isolated/npmrc",
    "/isolated/cache",
  );
  assert.deepEqual(clean, {
    PATH: "/runtime/bin",
    npm_execpath: "/npm-cli.js",
    npm_config_dry_run: "false",
    npm_config_bin_links: "true",
    npm_config_userconfig: "/isolated/npmrc",
    npm_config_cache: "/isolated/cache",
  });
});

test("package proof modes separate dirty-tree verification from strict release construction", () => {
  assert.deepEqual(verificationPolicy("local"), { mode: "local", artifactChannel: "local-dev" });
  assert.deepEqual(verificationPolicy("release"), { mode: "release", artifactChannel: "npm-package" });
  assert.deepEqual(parseVerificationArgs(["--local", "--json"]), { mode: "local", json: true });
  assert.deepEqual(parseVerificationArgs(["--release"]), { mode: "release", json: false });
  for (const invalid of [[], ["--json"], ["--local", "--release"], ["--unknown"]]) {
    assert.throws(() => parseVerificationArgs(invalid), /usage: verify-npm-package/);
  }
});

test("the tarball mode takes exactly one already-packed path", () => {
  assert.deepEqual(parseVerificationArgs(["--tarball", "/p/x.tgz", "--json"]), {
    mode: "tarball",
    tarball: "/p/x.tgz",
    json: true,
  });
  // --tarball needs a value and is mutually exclusive with the scratch modes and stray flags.
  for (const invalid of [
    ["--tarball"],
    ["--tarball", "--json"],
    ["--tarball", "/p/x.tgz", "--local"],
    ["--tarball", "/p/x.tgz", "--stray"],
  ]) {
    assert.throws(() => parseVerificationArgs(invalid), /usage: verify-npm-package/);
  }
});

test("the UI build launches npm shell-free through the lifecycle CLI path", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(uiBuildNpmInvocation(["run", "build"], { npm_execpath: npmCli }), {
    command: process.execPath,
    args: [npmCli, "run", "build"],
  });
  assert.throws(() => uiBuildNpmInvocation([], {}), /npm_execpath is required/);
});

test("command resolution cannot fall through to a same-named host binary", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentstate-lite-path-proof-"));
  const prefixBin = path.join(scratch, "prefix-bin");
  const hostBin = path.join(scratch, "host-bin");
  try {
    await Promise.all([mkdir(prefixBin), mkdir(hostBin)]);
    const hostCommand = path.join(hostBin, "aslite");
    await writeFile(hostCommand, "#!/bin/sh\nexit 0\n");
    await chmod(hostCommand, 0o755);
    const env = { PATH: `${prefixBin}:${hostBin}` };
    assert.equal(await resolveCommandOnPath("aslite", env, "linux"), hostCommand);
    await assert.rejects(() => assertCommandInBin("aslite", env, prefixBin, "linux"), /isolated npm prefix/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Windows resolution requires the npm .cmd shim inside the prefix", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentstate-lite-windows-bin-"));
  try {
    const shim = path.join(scratch, "aslite.cmd");
    await writeFile(shim, "@echo off\r\n");
    const env = { PATH: scratch, PATHEXT: ".EXE;.CMD" };
    assert.equal(await assertCommandInBin("aslite", env, scratch, "win32"), shim);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("installed create-only proof holds the real production lock boundary before publication", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "verify-npm-package.mjs"), "utf8");
  assert.match(source, /installed-lock-boundary-preload\.mjs/);
  assert.match(source, /--import/);
  assert.match(source, /holder\.acquired\.json/);
  assert.match(source, /contender\.contended\.json/);
  assert.match(source, /must remain unpublished while the production lock claim is held/);
  for (const action of ["install", "status", "uninstall"]) {
    assert.ok(
      source.includes(`["skill", "${action}", "--scope", "user", "--json"]`),
      `the installed verifier must exercise canonical user-scope skill ${action}`,
    );
    assert.ok(
      !source.includes(`["skill", "${action}", "--scope", "global", "--json"]`),
      `the installed verifier must not project compatibility-only global scope for ${action}`,
    );
  }
});

test("the complete local proof survives an untracked file and poisoned npm lifecycle configuration", async () => {
  const npmCli = process.env.npm_execpath?.trim();
  assert.ok(npmCli, "run this proof through npm so npm_execpath is available");
  const dirtyDir = await mkdtemp(path.join(repoRoot, ".verify-npm-package-dirty-"));
  try {
    await writeFile(path.join(dirtyDir, "untracked.txt"), "local verification must remain available\n");
    const result = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, "scripts", "verify-npm-package.mjs"), "--local", "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          npm_config_dry_run: "true",
          npm_config_workspaces: "false",
          npm_config_workspace: "superbee",
          npm_config_prefix: path.join(tmpdir(), "wrong-agentstate-lite-prefix"),
          npm_config_bin_links: "false",
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.mode, "local");
    assert.equal(receipt.identity.identity.artifact.channel, "local-dev");
    assert.equal(receipt.identity.identity.source.dirty, true);
  } finally {
    await rm(dirtyDir, { recursive: true, force: true });
  }
});
