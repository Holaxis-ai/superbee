import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  files: [
    { path: "package.json" },
    { path: "dist/agentstate-lite.mjs" },
    { path: "README.md" },
    { path: "LICENSE" },
    { path: "SKILL.md" },
    ...referenceFiles.map((relative) => ({ path: `references/${relative}` })),
  ],
};
const manifest = {
  name: "@holaxis/aslite",
  files: ["dist", "SKILL.md", "references"],
  bin: {
    aslite: "dist/agentstate-lite.mjs",
    "agentstate-lite": "dist/agentstate-lite.mjs",
  },
  publishConfig: { access: "public" },
  devDependencies: { local: "*" },
};

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

test("root and npm READMEs teach one literal create-only, agent-driven quickstart", async () => {
  for (const [label, file] of [
    ["root", path.join(repoRoot, "README.md")],
    ["npm", path.join(repoRoot, "packages", "cli", "README.md")],
  ]) {
    const readme = await readFile(file, "utf8");
    assert.match(
      readme,
      /init --create-only --recipe work-tracking/,
      `${label} README must use the safe literal work-tracking creation command`,
    );
    assert.match(
      readme,
      /bring source material or intent\s+to your agent/i,
      `${label} README must explain what the user contributes`,
    );
    assert.match(
      readme,
      /agent organizes,\s+types, links, and updates the\s+bundle/i,
      `${label} README must explain the agent's authoring role`,
    );
    assert.match(
      readme,
      /^npm install -g @holaxis\/aslite$/m,
      `${label} README must install the supported default package without a preview tag`,
    );
    assert.doesNotMatch(
      readme,
      /^(?:npm install -g|npx -y) @holaxis\/aslite@next\b/m,
      `${label} README must not teach the preview tag as the default journey`,
    );
    assert.doesNotMatch(
      readme,
      /^aslite (?:skill|hook) install --scope global\b/m,
      `${label} README must teach the canonical user scope`,
    );
    assert.match(
      readme,
      /`quickstart-agent` is an advisory example actor label; replace it with the actual agent identity\./,
      `${label} README must explain the tutorial actor label`,
    );
  }
});

test("the expected tarball set is the fixed base plus the references tree", () => {
  assert.deepEqual(expectedTarballFiles(["a.md", "b/c.md"]), [
    "LICENSE",
    "README.md",
    "SKILL.md",
    "dist/agentstate-lite.mjs",
    "package.json",
    "references/a.md",
    "references/b/c.md",
  ]);
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

test("the npm package contract rejects a second .mjs executable even when the file set matches", () => {
  const smuggled = [...referenceFiles, "scripts/helper.mjs"];
  const smuggledReceipt = {
    files: [...receipt.files, { path: "references/scripts/helper.mjs" }],
  };
  assert.throws(
    () => assertPackageContract(smuggledReceipt, manifest, smuggled),
    /exactly one \.mjs executable/,
  );
});

test("npm subprocesses discard inherited lifecycle, workspace, prefix, and bin settings", () => {
  const clean = sanitizedNpmEnvironment(
    {
      PATH: "/runtime/bin",
      npm_execpath: "/npm-cli.js",
      npm_config_dry_run: "true",
      NPM_CONFIG_WORKSPACES: "false",
      npm_config_workspace: "@holaxis/aslite",
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

test("the retained-artifact mode requires BOTH --tarball and --manifest", () => {
  assert.deepEqual(parseVerificationArgs(["--tarball", "/p/x.tgz", "--manifest", "/p/candidate.json", "--json"]), {
    mode: "tarball",
    tarball: "/p/x.tgz",
    manifest: "/p/candidate.json",
    json: true,
  });
  // The manifest is mandatory (QA finding #2): a bare --tarball is rejected. --tarball is also
  // mutually exclusive with the scratch modes and needs a value.
  for (const invalid of [
    ["--tarball"],
    ["--tarball", "--json"],
    ["--tarball", "/p/x.tgz"], // no manifest -> refused
    ["--tarball", "/p/x.tgz", "--local"],
    ["--tarball", "/p/x.tgz", "--manifest"],
    ["--tarball", "/p/x.tgz", "--manifest", "/p/c.json", "--stray"],
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
          npm_config_workspace: "@holaxis/aslite",
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
