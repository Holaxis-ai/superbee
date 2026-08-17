import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import {
  DEFAULT_RELEASE_TARGETS_PATH,
  RELEASE_CANDIDATE_SCHEMA,
  assertAllowedTuple,
  defaultReleaseTargets,
  loadReleaseTargets,
  tarballFilename,
} from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUCCESSOR_TARGET = defaultReleaseTargets()["successor-stable"];
const SUCCESSOR_PACKAGE_NAME = SUCCESSOR_TARGET.package.name;
const SUCCESSOR_INSTALL_ROOT = SUCCESSOR_TARGET.package.directory;
const SUCCESSOR_ARTIFACT = SUCCESSOR_TARGET.artifact;
const SUCCESSOR_BINS = SUCCESSOR_TARGET.bins;
const SUCCESSOR_BUILD_IDENTITY_SCHEMA = "superbee.build-identity.v1";

const baseExpectedFiles = ["LICENSE", "NOTICE", "README.md", "SKILL.md", SUCCESSOR_ARTIFACT, "package.json"];

/** The exact expected tarball file set: the fixed base plus the committed references/ tree. */
export function expectedTarballFiles(referenceFiles) {
  return [...baseExpectedFiles, ...referenceFiles.map((relative) => `references/${relative}`)].sort();
}
const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

function npmPrefixShimSource(prefix) {
  return `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") === "prefix --global") {
  console.log(${JSON.stringify(prefix)});
  process.exit(0);
}
console.error("npm verifier shim only supports: npm prefix --global");
process.exit(1);
`;
}

/** Fail closed if the retired first-party marketplace executable channel returns. */
export async function assertRetiredDistributionAbsent(root) {
  const retiredDirectories = [
    path.join(root, "plugins", "agentstate-lite"),
    path.join(root, ".claude-plugin"),
  ];
  for (const retiredPath of retiredDirectories) {
    const exists = await stat(retiredPath).then(() => true, () => false);
    if (!exists) continue;
    assert.equal(
      (await snapshotTree(retiredPath)).size,
      0,
      `${retiredPath} must stay absent; npm is the sole executable distribution authority`,
    );
  }
  const retiredRegistration = path.join(root, ".agents", "plugins", "marketplace.json");
  const registrationExists = await stat(retiredRegistration).then(() => true, () => false);
  assert.equal(
    registrationExists,
    false,
    `${retiredRegistration} must stay absent; npm is the sole executable distribution authority`,
  );
}

export function verificationPolicy(mode) {
  if (mode === "local") return { mode, artifactChannel: "local-dev" };
  if (mode === "release") return { mode, artifactChannel: "npm-package" };
  throw new Error("usage: verify-npm-package.mjs --local|--release [--json]");
}

const USAGE = "usage: verify-npm-package.mjs (--local | --release | --tarball <path> --manifest <path>) [--json]";

export function parseVerificationArgs(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");

  const tarballAt = rest.indexOf("--tarball");
  if (tarballAt !== -1) {
    // Retained-artifact mode: verify an ALREADY-PACKED tarball with NO build and NO pack. This is
    // the mode the staged-release workflow and prepublishOnly use so the verified bytes are the
    // SAME bytes that get staged/published — never a freshly-rebuilt second candidate. The manifest
    // is REQUIRED: without it the SHA cross-check is impossible and ANY valid npm-package tarball
    // would pass instead of specifically the staged candidate (QA finding #2). Fail closed.
    const tarball = rest[tarballAt + 1];
    if (!tarball || tarball.startsWith("--")) throw new Error(USAGE);
    const manifestAt = rest.indexOf("--manifest");
    if (manifestAt === -1) throw new Error(USAGE);
    const manifest = rest[manifestAt + 1];
    if (!manifest || manifest.startsWith("--")) throw new Error(USAGE);
    const consumed = new Set([tarballAt, tarballAt + 1, manifestAt, manifestAt + 1]);
    const leftover = rest.filter((_, i) => !consumed.has(i));
    if (leftover.length !== 0) throw new Error(USAGE);
    return { mode: "tarball", tarball, manifest, json };
  }

  if (rest.length !== 1 || (rest[0] !== "--local" && rest[0] !== "--release")) {
    throw new Error(USAGE);
  }
  return { mode: rest[0].slice(2), json };
}

function npmInvocation(args, env = process.env) {
  const npmCli = env.npm_execpath?.trim();
  if (!npmCli) {
    throw new Error("npm_execpath is required; run `npm run verify:npm-package` from the repository root");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const details = [
        `Command failed: ${command} ${args.join(" ")}`,
        error.stdout ? `stdout:\n${error.stdout}` : null,
        error.stderr ? `stderr:\n${error.stderr}` : null,
      ].filter(Boolean).join("\n");
      error.message = `${details}\n${error.message}`;
    }
    throw error;
  }
}

async function waitForJsonFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      const retryable = error?.code === "ENOENT" || error instanceof SyntaxError;
      if (!retryable) throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for installed lock marker ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function installedLockBoundaryPreloadSource() {
  return `import { promises as fs } from "node:fs";
import path from "node:path";

const barrierDir = process.env.ASLITE_INSTALLED_LOCK_BARRIER_DIR;
const role = process.env.ASLITE_INSTALLED_LOCK_BARRIER_ROLE;
if (!barrierDir || (role !== "holder" && role !== "contender")) {
  throw new Error("installed lock-boundary preload requires barrier directory and role");
}

const originalMkdir = fs.mkdir.bind(fs);
const releaseFile = path.join(barrierDir, "holder.release");
const holderAcquiredFile = path.join(barrierDir, "holder.acquired.json");
let boundaryObserved = false;

async function waitFor(file) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error("timed out waiting for installed lock barrier " + file);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function mark(name, details) {
  await fs.writeFile(
    path.join(barrierDir, name),
    JSON.stringify({ ...details, node: process.versions.node }) + "\\n",
    "utf8",
  );
}

fs.mkdir = async function instrumentedMkdir(requested, options) {
  const lockPath = typeof requested === "string" ? requested : "";
  const lockRootName = lockPath ? path.basename(path.dirname(lockPath)) : "";
  const productionClaim =
    !boundaryObserved &&
    lockPath.endsWith(".lock") &&
    lockRootName.startsWith("agentstate-lite-mutation-locks-") &&
    options?.recursive !== true;
  if (!productionClaim) return originalMkdir(requested, options);

  boundaryObserved = true;
  await mark(role + ".attempt.json", { lock_path: lockPath });
  if (role === "holder") {
    const result = await originalMkdir(requested, options);
    await mark("holder.acquired.json", { lock_path: lockPath });
    await waitFor(releaseFile);
    return result;
  }

  await waitFor(holderAcquiredFile);
  try {
    const result = await originalMkdir(requested, options);
    await mark("contender.unexpected-acquire.json", { lock_path: lockPath });
    return result;
  } catch (error) {
    await mark("contender.contended.json", { lock_path: lockPath, fs_code: error?.code });
    throw error;
  }
};
`;
}

export function sanitizedNpmEnvironment(source, userConfig, cache) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.toLowerCase().startsWith("npm_config_")) env[key] = value;
  }
  const sanitized = {
    ...env,
    npm_config_dry_run: "false",
    npm_config_bin_links: "true",
    npm_config_userconfig: userConfig,
  };
  if (cache) sanitized.npm_config_cache = cache;
  return sanitized;
}

async function runNpm(args, options = {}) {
  const env = sanitizedNpmEnvironment(
    options.env ?? process.env,
    options.npmUserConfig,
    options.npmCache,
  );
  const invocation = npmInvocation(args, env);
  const { npmUserConfig: _, npmCache: __, ...runOptions } = options;
  return run(invocation.command, invocation.args, { ...runOptions, env });
}

function hasWorkspaceReference(value) {
  if (typeof value === "string") return value.startsWith("workspace:");
  if (Array.isArray(value)) return value.some(hasWorkspaceReference);
  if (value && typeof value === "object") return Object.values(value).some(hasWorkspaceReference);
  return false;
}

export function assertPackageContract(receipt, manifest, referenceFiles, target = SUCCESSOR_TARGET) {
  const tarballFiles = receipt.files.map((file) => file.path).sort();
  const expectedArtifact = target.artifact;
  assert.deepEqual(
    tarballFiles,
    expectedArtifact === SUCCESSOR_ARTIFACT
      ? expectedTarballFiles(referenceFiles)
      : ["LICENSE", "NOTICE", "README.md", "SKILL.md", expectedArtifact, "package.json", ...referenceFiles.map((relative) => `references/${relative}`)].sort(),
    "the npm tarball must contain only the CLI, manifest, README, LICENSE, NOTICE, SKILL.md, and references/",
  );
  assert.deepEqual(
    tarballFiles.filter((file) => file.endsWith(".mjs")),
    [expectedArtifact],
    "the tarball must carry exactly one .mjs executable (the dist bundle)",
  );
  assert.equal(manifest.name, target.package.name);
  // NOTICE must be listed explicitly: npm ships LICENSE regardless of files[], but NOTICE only
  // when named, and Apache-2.0 section 4(d) requires the notice to travel with the distribution.
  assert.deepEqual(manifest.files, ["dist", "SKILL.md", "references", "NOTICE"]);
  assert.deepEqual(manifest.bin, target.bins);
  // Scoped packages default to restricted at publish time — the manifest must pin public.
  assert.deepEqual(manifest.publishConfig, { access: "public" }, "publishConfig.access must be public");
  for (const field of runtimeDependencyFields) {
    assert.ok(
      manifest[field] === undefined || Object.keys(manifest[field]).length === 0,
      `${field} must be empty in the published CLI`,
    );
  }
  assert.equal(hasWorkspaceReference(manifest), false, "the published manifest must not contain workspace: references");
}

async function listFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function snapshotTree(root) {
  const snapshot = new Map();
  for (const relative of await listFiles(root)) {
    const absolute = path.join(root, relative);
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    snapshot.set(relative.split(path.sep).join("/"), { bytes, mode: info.mode });
  }
  return snapshot;
}

function assertSnapshotUnchanged(before, after, label) {
  assert.deepEqual([...after.keys()], [...before.keys()], `${label} file set changed during npm verification`);
  for (const [relative, expected] of before) {
    const actual = after.get(relative);
    assert.ok(actual.bytes.equals(expected.bytes), `${label}${relative} changed during npm verification`);
    assert.equal(actual.mode, expected.mode, `${label}${relative} mode changed during npm verification`);
  }
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${error.message}`);
  }
}

function pathDelimiter(platform) {
  return platform === "win32" ? ";" : ":";
}

function normalizedPath(value, platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function resolveCommandOnPath(command, env, platform = process.platform) {
  const directories = (env.PATH ?? "").split(pathDelimiter(platform)).filter(Boolean);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the explicit PATH.
      }
    }
  }
  return undefined;
}

export async function assertCommandInBin(command, env, binDir, platform = process.platform) {
  const expected = path.join(binDir, platform === "win32" ? `${command}.cmd` : command);
  const resolved = await resolveCommandOnPath(command, env, platform);
  assert.equal(
    resolved && normalizedPath(resolved, platform),
    normalizedPath(expected, platform),
    `${command} must resolve from the isolated npm prefix`,
  );
  return expected;
}

/** SHA-256 of a file, prefixed `sha256:` (the build-identity convention). */
export async function fileSha256(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

/**
 * Two producers, ONE proof. `spec.produce({ scratch, packDir, npmUserConfig, npmCache })` returns
 * `{ tarball, meta }`: either builds+packs a fresh scratch candidate (developer/PR modes) OR
 * accepts an ALREADY-RETAINED tarball and packs nothing (the staged-release path). The install +
 * contract + workflow + identity proof below is byte-for-byte identical across both — the ONLY
 * difference is where the tarball came from, which is exactly the retained-artifact invariant:
 * the bytes we prove are the bytes that ship.
 */
async function runInstalledProof(spec) {
  const target = spec.target ?? SUCCESSOR_TARGET;
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-npm-proof-")));
  const packDir = path.join(scratch, "pack");
  const prefix = path.join(scratch, "prefix");
  const home = path.join(scratch, "home");
  const quickstartProject = path.join(scratch, "quickstart-project");
  const quickstartMarker = path.join(quickstartProject, "existing-project-file.txt");
  const bundle = path.join(quickstartProject, ".agentstate-lite");
  const npmUserConfig = path.join(scratch, "empty-npmrc");
  const npmCache = path.join(scratch, "npm-cache");
  await assertRetiredDistributionAbsent(repoRoot);

  try {
    await Promise.all([mkdir(packDir), mkdir(prefix), mkdir(home), mkdir(quickstartProject)]);
    await writeFile(npmUserConfig, "");
    await writeFile(quickstartMarker, "unrelated project content must survive\n");
    const { tarball, meta } = await spec.produce({ scratch, packDir, npmUserConfig, npmCache });

    await runNpm(
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: scratch, npmUserConfig, npmCache },
    );

    const installedRoot =
      process.platform === "win32"
        ? path.join(prefix, "node_modules", ...target.package.directory)
        : path.join(prefix, "lib", "node_modules", ...target.package.directory);
    const manifest = parseJson(await readFile(path.join(installedRoot, "package.json"), "utf8"), "installed package.json");
    const committedSkillRoot = path.join(repoRoot, "packages", "cli");
    const referenceFiles = (await listFiles(path.join(committedSkillRoot, "references"))).map((relative) =>
      relative.split(path.sep).join("/"),
    );
    // Derive the tarball's file set from the installed tree so the contract check holds in BOTH
    // producer modes (retained mode never sees npm pack's file list). The installed
    // node_modules/superbee tree IS the tarball's contents.
    const contractReceipt = {
      files: (await listFiles(installedRoot)).map((relative) => ({ path: relative.split(path.sep).join("/") })),
    };
    assertPackageContract(contractReceipt, manifest, referenceFiles, target);

    // The shipped skill assets are byte-identical to the repo-committed generated ones (which
    // check:skill pins to the renderer + resource manifest).
    for (const relative of ["SKILL.md", ...referenceFiles.map((file) => `references/${file}`)]) {
      const installed = await readFile(path.join(installedRoot, relative));
      const committed = await readFile(path.join(committedSkillRoot, relative));
      assert.ok(installed.equals(committed), `${relative} in the installed package differs from the committed copy`);
    }
    const installedSkill = await readFile(path.join(installedRoot, "SKILL.md"), "utf8");
    assert.ok(
      !installedSkill.includes("npx -y agentstate-lite"),
      "the installed SKILL.md must not use the retired npm coordinate",
    );
    for (const marker of ["plugins/cache", 'ASLITE="$(']) {
      assert.ok(
        !installedSkill.includes(marker),
        `the installed SKILL.md must not carry the marketplace-cache resolver (found ${JSON.stringify(marker)})`,
      );
    }
    assert.ok(
      installedSkill.includes('REFS="<skill-base-dir>/references"'),
      "the installed SKILL.md must instruct setting $REFS from the host-reported skill base directory",
    );
    for (const banned of ["cat references/", "promote references/"]) {
      assert.ok(
        !installedSkill.includes(banned),
        `the installed SKILL.md must not emit cwd-relative reference commands (found ${JSON.stringify(banned)})`,
      );
    }

    const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    if (process.platform !== "win32") {
      // `npm install --prefix` builds an isolated package prefix but not a Node installation.
      // Model the supported real-world POSIX global layout so durable hook authority can prove
      // and persist the stable <prefix>/bin/node launcher.
      await symlink(process.execPath, path.join(binDir, "node"));
      const npmShim = path.join(binDir, "npm");
      await writeFile(npmShim, npmPrefixShimSource(prefix), { mode: 0o755 });
    }
    const commandEnv = {
      ...sanitizedNpmEnvironment(process.env, npmUserConfig, npmCache),
      PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`,
      npm_config_prefix: prefix,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
    };
    for (const command of target.expected_commands) await assertCommandInBin(command, commandEnv, binDir);
    for (const absent of ["superbee", "aslite", "agentstate-lite"].filter((command) => !target.expected_commands.includes(command))) {
      const resolved = await resolveCommandOnPath(absent, commandEnv);
      assert.equal(resolved, undefined, `${absent} must not resolve from the isolated npm prefix for ${target.id}`);
    }

    const installedEntrypoint = path.join(installedRoot, manifest.bin[target.preferred_command]);
    for (const [bin, relative] of Object.entries(manifest.bin)) {
      assert.equal(relative, manifest.bin[target.preferred_command], `${bin} must point at the target artifact`);
    }
    const runCli = (command, args, options = {}) => {
      const cwd = options.cwd ?? scratch;
      const env = { ...commandEnv, ...(options.env ?? {}) };
      return process.platform === "win32"
        ? run(process.execPath, [installedEntrypoint, ...args], { cwd, env })
        : run(command, args, { cwd, env });
    };

    // Every command declared by the selected release target agrees with the immutable build
    // identity; the adjacent installed manifest is diagnostic rather than authority.
    const preferredVersion = (await runCli(target.preferred_command, ["--version"])).stdout.trim();
    assert.equal(preferredVersion, manifest.version, `${target.preferred_command} --version must equal the package manifest`);
    for (const command of target.expected_commands.filter((command) => command !== target.preferred_command)) {
      const versionOut = (await runCli(command, command === "agentstate-lite" ? ["-v"] : ["--version"])).stdout.trim();
      assert.equal(versionOut, manifest.version, `${command} --version must equal the package manifest`);
    }
    const preferredIdentity = parseJson(
      (await runCli(target.preferred_command, ["version", "--json"])).stdout,
      `${target.preferred_command} version --json`,
    );
    for (const command of target.expected_commands.filter((command) => command !== target.preferred_command)) {
      const identity = parseJson(
        (await runCli(command, ["version", "--json"])).stdout,
        `${command} version --json`,
      );
      assert.deepEqual(identity, preferredIdentity, `${command} alias must report the canonical target identity`);
    }
    assert.equal(preferredIdentity.identity.schema, SUCCESSOR_BUILD_IDENTITY_SCHEMA);
    assert.deepEqual(preferredIdentity.identity.package, {
      name: target.package.name,
      version: manifest.version,
    });
    assert.equal(preferredIdentity.identity.artifact.channel, spec.expectedChannel);
    const installedSha = `sha256:${createHash("sha256").update(await readFile(installedEntrypoint)).digest("hex")}`;
    assert.equal(preferredIdentity.identity.artifact.sha256, installedSha);
    const installedEntrypointRealPath = await realpath(installedEntrypoint);
    assert.equal(preferredIdentity.identity.runtime.executable_path, installedEntrypointRealPath);
    assert.deepEqual(preferredIdentity.identity.compatibility_contracts, { skill: 1, hook: 1, mcp: 1 });
    assert.deepEqual(preferredIdentity.drift, {
      adjacent_package_version: manifest.version,
      version_mismatch: false,
    });

    if (target.workflow_contract === "identity-only") {
      return {
        mode: spec.mode,
        package: `${manifest.name}@${manifest.version}`,
        files: contractReceipt.files.length,
        bins: Object.keys(manifest.bin),
        workflow: ["identity-only: install -> command presence -> version identity"],
        identity: preferredIdentity,
        tarball: {
          path: meta.path ?? null,
          filename: meta.filename,
          sha256: meta.sha256 ?? (await fileSha256(tarball)),
          shasum: meta.shasum,
          integrity: meta.integrity,
          size: meta.size,
          unpacked_size: meta.unpackedSize,
        },
      };
    }

    const discoverySnapshot = await snapshotTree(quickstartProject);
    const noBundleHome = parseJson(
      (await runCli(target.preferred_command, ["--json"], { cwd: quickstartProject })).stdout,
      `${target.preferred_command} home --json outside a bundle`,
    );
    const homeIdentity = noBundleHome.superbee;
    assert.equal(homeIdentity.version, manifest.version);
    assert.equal(homeIdentity.channel, spec.expectedChannel);
    assert.equal(homeIdentity.bin, installedEntrypointRealPath);
    assert.match(
      noBundleHome.getting_started,
      /init --create-only --recipe none --dir '\.agentstate-lite'/,
      "bundle-free home must advertise fail-closed conventional creation",
    );
    assert.match(
      noBundleHome.getting_started,
      new RegExp(`${target.preferred_command} recipes`),
      "bundle-free home must point at Recipe discovery",
    );

    for (const command of target.expected_commands) await runCli(command, ["--help"]);
    const initHelp = (await runCli(target.preferred_command, ["init", "--help"])).stdout;
    assert.match(
      initHelp,
      /(?:superbee|agentstate-lite|aslite) recipes/,
      "init help must point at recipe discovery through an installed bin alias",
    );
    const discoveredRecipes = parseJson(
      (await runCli(target.preferred_command, ["recipes", "--json"], { cwd: quickstartProject })).stdout,
      "bundle-free recipes",
    );
    assert.ok(discoveredRecipes.count >= 3, "the installed CLI must discover the built-in recipe inventory");
    const contextNotes = discoveredRecipes.recipes.find((recipe) => recipe.name === "context-notes");
    assert.ok(contextNotes, "the installed recipe inventory must include context-notes");
    assert.equal(contextNotes.applied, null, "bundle-free discovery must not imply an applied state");
    assert.deepEqual(contextNotes.commands, {
      create_bundle: `${target.preferred_command} init --create-only --recipe context-notes --dir '.agentstate-lite'`,
      add_to_bundle: `${target.preferred_command} recipe add context-notes`,
    });
    const workTracking = discoveredRecipes.recipes.find((recipe) => recipe.name === "work-tracking");
    assert.ok(workTracking, "the installed recipe inventory must include work-tracking");
    assert.deepEqual(workTracking.commands, {
      create_bundle: `${target.preferred_command} init --create-only --recipe work-tracking --dir '.agentstate-lite'`,
      add_to_bundle: `${target.preferred_command} recipe add work-tracking`,
    });
    assertSnapshotUnchanged(
      discoverySnapshot,
      await snapshotTree(quickstartProject),
      "bundle-free home/recipe discovery must not change the project: ",
    );
    assert.deepEqual(
      await readdir(quickstartProject),
      [path.basename(quickstartMarker)],
      "bundle-free discovery must leave only the pre-existing project file",
    );
    await run(workTracking.commands.create_bundle, [], {
      cwd: quickstartProject,
      env: commandEnv,
      shell: true,
    });
    await stat(path.join(bundle, "index.md"));
    await stat(quickstartMarker);
    assert.match(await readFile(path.join(bundle, "index.md"), "utf8"), /okf_version: ['"]?0\.2['"]?/);
    const defaultTaskConvention = await readFile(path.join(bundle, "conventions", "task.md"), "utf8");
    assert.match(defaultTaskConvention, /superbee_progress_status/);
    assert.doesNotMatch(defaultTaskConvention, /^\s*status:/m);

    // The same installed guard must refuse to turn the new quickstart workspace into an
    // open-or-modify path. Execute the emitted command again, byte for byte, and pin the whole
    // non-empty project tree so neither bundle nor unrelated project bytes can move.
    const projectSnapshotBeforeRetry = await snapshotTree(quickstartProject);
    const refused = await run(workTracking.commands.create_bundle, [], {
      cwd: quickstartProject,
      env: commandEnv,
      shell: true,
    }).then(
      () => {
        throw new Error("init --create-only over an existing bundle must exit non-zero");
      },
      (error) => error,
    );
    assert.match(String(refused.stdout ?? refused.message), /already an OKF bundle/);
    assert.equal(refused.code, 5, "create-only refusal must use the conflict exit class");
    assertSnapshotUnchanged(
      projectSnapshotBeforeRetry,
      await snapshotTree(quickstartProject),
      "create-only refusal must not change the quickstart project: ",
    );

    // Node's ESM --import preload is common to the supported Node 20/22/26 lines. Instrument the
    // installed process externally (never through a product test hook) at its actual atomic
    // production-lock mkdir: the holder owns the real lock directory while the contender proves
    // EEXIST on the exact same path, and neither command may publish before the verifier releases it.
    const installedRaceRoot = path.join(scratch, "create-only-production-lock");
    const installedRaceParent = path.join(installedRaceRoot, "parent");
    const installedRaceChild = path.join(installedRaceParent, "deep", "child");
    const installedBarrierDir = path.join(scratch, "installed-lock-boundary");
    const installedPreload = path.join(installedBarrierDir, "installed-lock-boundary-preload.mjs");
    await mkdir(installedBarrierDir);
    await writeFile(installedPreload, installedLockBoundaryPreloadSource());
    const runBarrierContender = (role, target) =>
      run(
        process.execPath,
        [
          "--import",
          pathToFileURL(installedPreload).href,
          installedEntrypoint,
          "init",
          "--create-only",
          "--dir",
          target,
          "--recipe",
          "none",
          "--json",
        ],
        {
          cwd: scratch,
          env: {
            ...commandEnv,
            ASLITE_INSTALLED_LOCK_BARRIER_DIR: installedBarrierDir,
            ASLITE_INSTALLED_LOCK_BARRIER_ROLE: role,
          },
        },
      ).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );

    const holderRun = runBarrierContender("holder", installedRaceParent);
    const contenderRun = runBarrierContender("contender", installedRaceChild);
    let barrierFailure;
    try {
      const [holderAttempt, contenderAttempt, holderAcquired, contenderContended] = await Promise.all([
        waitForJsonFile(path.join(installedBarrierDir, "holder.attempt.json")),
        waitForJsonFile(path.join(installedBarrierDir, "contender.attempt.json")),
        waitForJsonFile(path.join(installedBarrierDir, "holder.acquired.json")),
        waitForJsonFile(path.join(installedBarrierDir, "contender.contended.json")),
      ]);
      assert.equal(holderAttempt.lock_path, contenderAttempt.lock_path);
      assert.equal(holderAcquired.lock_path, holderAttempt.lock_path);
      assert.equal(contenderContended.lock_path, holderAttempt.lock_path);
      assert.equal(contenderContended.fs_code, "EEXIST");
      assert.equal(
        await access(path.join(installedBarrierDir, "contender.unexpected-acquire.json")).then(
          () => true,
          () => false,
        ),
        false,
        "the contender must observe the holder's real production lock",
      );
      assert.equal(
        (await access(path.join(installedRaceParent, "index.md")).then(() => true, () => false)) ||
          (await access(path.join(installedRaceChild, "index.md")).then(() => true, () => false)),
        false,
        "installed contenders must remain unpublished while the production lock claim is held",
      );
    } catch (error) {
      barrierFailure = error;
    } finally {
      await writeFile(path.join(installedBarrierDir, "holder.release"), "release\n");
    }

    const installedRace = await Promise.all([holderRun, contenderRun]);
    if (barrierFailure) throw barrierFailure;
    assert.equal(installedRace[0].status, "fulfilled", "installed production-lock holder must win");
    assert.equal(installedRace[1].status, "rejected", "installed production-lock contender must lose");
    parseJson(installedRace[0].value.stdout, "installed create-only production-lock winner");
    assert.equal(installedRace[1].reason.code, 5, "installed production-lock loser must use conflict exit 5");
    assert.equal(
      (await access(path.join(installedRaceParent, "index.md")).then(() => true, () => false)) &&
        (await access(path.join(installedRaceChild, "index.md")).then(() => true, () => false)),
      false,
      "installed production lock must never allow both nested bundles to publish",
    );
    assert.match(initHelp, /--create-only/, "installed init help must carry the exact create-only spelling");
    const appliedRecipes = parseJson(
      (await runCli(target.preferred_command, ["recipes", "--dir", bundle, "--json"])).stdout,
      "bundle recipes",
    );
    assert.equal(
      appliedRecipes.recipes.find((recipe) => recipe.name === "work-tracking")?.applied,
      true,
      "the installed recipe inventory must retain bundle-aware applied state",
    );
    assert.deepEqual(
      appliedRecipes.recipes.find((recipe) => recipe.name === "work-tracking")?.commands,
      { add_to_bundle: `${target.preferred_command} recipe add work-tracking --dir '${bundle}'` },
      "an existing local bundle must expose only the actionable add command",
    );
    parseJson(
      (
        await runCli(target.preferred_command, [
          "new",
          "Task",
          "first-task",
          "--title",
          "Plan the first change",
          "--progress_status",
          "todo",
          "--actor",
          "quickstart-agent",
          "--dir",
          bundle,
          "--json",
        ])
      ).stdout,
      "new",
    );
    const createdTask = parseJson(
      (await runCli(target.preferred_command, ["doc", "read", "tasks/first-task", "--dir", bundle, "--json"])).stdout,
      "read attributed quickstart Task",
    );
    assert.equal(
      createdTask.superbee_updated_by,
      "quickstart-agent",
      "the literal quickstart Task must retain current-format attribution",
    );
    assert.equal(createdTask.title, "Plan the first change", "the verifier must execute the documented Task command");
    const rawDefaultTask = await readFile(path.join(bundle, "tasks", "first-task.md"), "utf8");
    assert.match(rawDefaultTask, /^superbee_progress_status: todo$/m);
    assert.match(rawDefaultTask, /^superbee_updated_by: quickstart-agent$/m);
    assert.doesNotMatch(rawDefaultTask, /^status:/m);
    assert.doesNotMatch(rawDefaultTask, /^actor:/m);
    assert.doesNotMatch(rawDefaultTask, /^timestamp:/m);
    parseJson(
      (
        await runCli(target.preferred_command, [
          "doc",
          "update",
          "tasks/first-task",
          "--progress_status",
          "done",
          "--actor",
          "quickstart-agent",
          "--dir",
          bundle,
          "--json",
        ])
      ).stdout,
      "update default Task",
    );
    const listed = parseJson(
      (
        await runCli(target.preferred_command, [
          "list",
          "--type",
          "Task",
          "--field",
          "progress_status=done",
          "--dir",
          bundle,
          "--json",
        ])
      ).stdout,
      "list",
    );
    assert.ok(
      JSON.stringify(listed).includes("tasks/first-task"),
      "the installed CLI must list the Task it created",
    );
    const productiveHome = parseJson(
      (await runCli(target.preferred_command, ["--dir", bundle, "--json"])).stdout,
      "productive quickstart home",
    );
    assert.ok(
      productiveHome.bundle.recent.rows.some((row) => row.id === "tasks/first-task"),
      "home must surface the new Task as useful live state",
    );
    const productiveStatus = parseJson(
      (await runCli(target.preferred_command, ["status", "--dir", bundle, "--json"])).stdout,
      "productive quickstart status",
    );
    assert.equal(productiveStatus.kind_warnings, 0, "the attributed Task must keep the quickstart bundle kind-clean");
    const taskHistory = parseJson(
      (await runCli(target.preferred_command, ["doc", "history", "tasks/first-task", "--dir", bundle, "--json"])).stdout,
      "default Task history",
    );
    assert.ok(taskHistory.versions[0].actor, "local history must expose its backend principal");
    // The old edition remains an explicit compatibility path, and reopening it through ordinary
    // init must preserve its declared edition and installed definitions byte for byte.
    const legacyBundle = path.join(scratch, "explicit-legacy-bundle");
    parseJson(
      (
        await runCli(target.preferred_command, [
          "init",
          "--create-only",
          "--okf-version",
          "0.1",
          "--recipe",
          "work-tracking",
          "--dir",
          legacyBundle,
          "--json",
        ])
      ).stdout,
      "installed explicit legacy init",
    );
    const legacyIndex = await readFile(path.join(legacyBundle, "index.md"), "utf8");
    const legacyConvention = await readFile(path.join(legacyBundle, "conventions", "task.md"), "utf8");
    assert.match(legacyIndex, /okf_version: ['"]?0\.1['"]?/);
    assert.match(legacyConvention, /^\s*- status$/m);
    assert.doesNotMatch(legacyConvention, /superbee_progress_status/);
    parseJson(
      (
        await runCli(target.preferred_command, [
          "init",
          "--dir",
          legacyBundle,
          "--recipe",
          "work-tracking",
          "--json",
        ])
      ).stdout,
      "reopen installed legacy bundle",
    );
    assert.equal(
      await readFile(path.join(legacyBundle, "index.md"), "utf8"),
      legacyIndex,
      "ordinary reopen must preserve the legacy root claim",
    );
    assert.equal(
      await readFile(path.join(legacyBundle, "conventions", "task.md"), "utf8"),
      legacyConvention,
      "ordinary reopen must preserve legacy recipe definitions",
    );

    const installedReadme = await readFile(path.join(installedRoot, "README.md"), "utf8");
    assert.match(installedReadme, /init --create-only --recipe work-tracking/);
    assert.match(installedReadme, /bring source material or intent\s+to your agent/i);
    assert.match(installedReadme, /agent organizes,\s+types, links, and updates the\s+bundle/i);
    assert.match(installedReadme, /^npm install -g superbee$/m);
    assert.match(installedReadme, /^superbee setup$/m);
    assert.match(
      installedReadme,
      /`quickstart-agent` is an advisory example actor label; replace it with the actual agent identity\./,
    );

    const setupBeforeIntegrations = parseJson(
      (
        await runCli(target.preferred_command, ["setup", "--host", "claude-code", "--json"], {
          cwd: scratch, env: { CLAUDE_CONFIG_DIR: "" },
        })
      ).stdout,
      "setup before integrations",
    );
    assert.equal(setupBeforeIntegrations.setup.host, "claude-code");
    assert.equal(setupBeforeIntegrations.setup.ready, false);
    assert.equal(
      setupBeforeIntegrations.setup.next.command,
      "superbee skill install --scope user",
      "the installed artifact must guide the first missing host integration without exposing paths",
    );
    assert.doesNotMatch(JSON.stringify(setupBeforeIntegrations), new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // ── skill-channel proof: install → status → reinstall no-op → uninstall, project + user ──
    const project = path.join(scratch, "skill-project");
    const foreignSkill = path.join(project, ".claude", "skills", "foreign");
    await mkdir(foreignSkill, { recursive: true });
    await writeFile(path.join(foreignSkill, "SKILL.md"), "# foreign skill — must survive\n");

    const skillInstall = parseJson(
      (await runCli(target.preferred_command, ["skill", "install", "--scope", "project", "--json"], { cwd: project })).stdout,
      "skill install",
    );
    assert.equal(skillInstall.skill.changed, true, "first skill install must report changed");
    for (const host of [".claude", ".codex"]) {
      const dir = path.join(project, host, "skills", "superbee");
      await assert.rejects(
        stat(path.join(project, host, "skills", "aslite")),
        /ENOENT/,
        `${host}/skills/aslite must not be created by a fresh install`,
      );
      const installedSkillMd = await readFile(path.join(dir, "SKILL.md"));
      assert.ok(
        installedSkillMd.equals(await readFile(path.join(committedSkillRoot, "SKILL.md"))),
        `${host} installed skill SKILL.md must match the shipped copy`,
      );
      for (const relative of referenceFiles) {
        const bytes = await readFile(path.join(dir, "references", ...relative.split("/")));
        assert.ok(
          bytes.equals(await readFile(path.join(committedSkillRoot, "references", relative))),
          `${host} installed reference ${relative} must match the shipped copy`,
        );
      }
      const skillManifest = parseJson(
        await readFile(path.join(dir, ".aslite-skill.json"), "utf8"),
        "skill manifest",
      );
      // The serialized receipt identifiers remain compatible inside the canonical skill folder.
      // New receipts identify the canonical successor package — the ownership marker a later
      // `skill install` recognizes — and NOT the npm coordinate this bundle shipped under. One
      // bundle publishes as both the bridge and the successor, and the installer writes the
      // successor spelling from either. Asserting the shipped coordinate here made the bridge
      // tuple unverifiable through the retained-tarball proof.
      assert.equal(skillManifest.package, SUCCESSOR_PACKAGE_NAME);
      assert.equal(skillManifest.version, manifest.version);
    }

    const skillStatus = parseJson(
      (await runCli(target.preferred_command, ["skill", "status", "--scope", "project", "--json"], { cwd: project })).stdout,
      "skill status",
    );
    assert.equal(skillStatus.skill.hosts.claude_code.state, "installed");
    assert.equal(skillStatus.skill.hosts.codex.state, "installed");
    assert.equal(skillStatus.skill.hosts.claude_code.canonical.state, "installed");
    assert.equal(skillStatus.skill.hosts.claude_code.legacy.state, "absent");

    // Follow the installed SKILL.md's own $REFS instruction from the project ROOT: the host
    // reports the skill base dir; REFS = <base>/references, and $REFS/<dest> resolves from any cwd.
    const skillBaseDir = path.join(project, ".claude", "skills", "superbee");
    const refsDir = path.join(skillBaseDir, "references");
    const authoringViaRefs = await readFile(path.join(refsDir, "views", "references", "view-authoring-v0.md"));
    assert.ok(
      authoringViaRefs.equals(
        await readFile(path.join(committedSkillRoot, "references", "views", "references", "view-authoring-v0.md")),
      ),
      "the $REFS composition instructed by the installed SKILL.md must resolve the shipped reference from the project root",
    );

    const skillReinstall = parseJson(
      (await runCli(target.preferred_command, ["skill", "install", "--scope", "project", "--json"], { cwd: project })).stdout,
      "skill reinstall",
    );
    assert.equal(skillReinstall.skill.changed, false, "reinstall over a current install must be a no-op");

    parseJson(
      (await runCli(target.preferred_command, ["skill", "uninstall", "--scope", "project", "--json"], { cwd: project })).stdout,
      "skill uninstall",
    );
    for (const host of [".claude", ".codex"]) {
      await assert.rejects(
        stat(path.join(project, host, "skills", "superbee")),
        /ENOENT/,
        `${host}/skills/superbee must be gone after uninstall`,
      );
    }
    assert.equal(
      (await readFile(path.join(foreignSkill, "SKILL.md"), "utf8")).includes("must survive"),
      true,
      "a foreign sibling skill must survive uninstall",
    );

    // User scope under relocated host homes (CLAUDE_CONFIG_DIR / CODEX_HOME).
    const relocatedClaude = path.join(scratch, "relocated-claude");
    const relocatedCodex = path.join(scratch, "relocated-codex");
    const relocatedEnv = { CLAUDE_CONFIG_DIR: relocatedClaude, CODEX_HOME: relocatedCodex };
    parseJson(
      (
        await runCli(target.preferred_command, ["skill", "install", "--scope", "user", "--json"], {
          cwd: project,
          env: relocatedEnv,
        })
      ).stdout,
      "skill install user",
    );
    for (const dir of [relocatedClaude, relocatedCodex]) {
      await stat(path.join(dir, "skills", "superbee", "SKILL.md"));
      await assert.rejects(stat(path.join(dir, "skills", "aslite")), /ENOENT/);
    }
    const userStatus = parseJson(
      (
        await runCli(target.preferred_command, ["skill", "status", "--scope", "user", "--json"], {
          cwd: project,
          env: relocatedEnv,
        })
      ).stdout,
      "skill status user",
    );
    assert.equal(userStatus.skill.hosts.claude_code.state, "installed");
    assert.equal(userStatus.skill.hosts.codex.state, "installed");
    parseJson(
      (
        await runCli(target.preferred_command, ["skill", "uninstall", "--scope", "user", "--json"], {
          cwd: project,
          env: relocatedEnv,
        })
      ).stdout,
      "skill uninstall user",
    );
    for (const dir of [relocatedClaude, relocatedCodex]) {
      await assert.rejects(stat(path.join(dir, "skills", "superbee")), /ENOENT/, `${dir} must be cleaned up`);
    }

    // ── hook-command stability: installed hooks bind Node + the package entry, never ambient PATH ──
    parseJson(
      (await runCli(target.preferred_command, ["hook", "install", "--scope", "project", "--json"], { cwd: project })).stdout,
      "hook install",
    );
    const settings = parseJson(
      await readFile(path.join(project, ".claude", "settings.json"), "utf8"),
      "project .claude/settings.json",
    );
    const hookCommands = (settings.hooks?.SessionStart ?? []).flatMap((group) =>
      (group.hooks ?? []).map((h) => h.command),
    );
    if (process.platform === "win32") {
      assert.equal(hookCommands.length, 1, "exactly one managed SessionStart hook");
      assert.ok(hookCommands[0].endsWith(" session-start"), "hook must run session-start");
    } else {
      assert.deepEqual(
        hookCommands,
        [
          `${path.join(prefix, "bin", "node")} ${installedEntrypointRealPath} session-start`,
        ],
        "the installed hook must use absolute Node and package-entry paths",
      );
    }
    parseJson(
      (await runCli(target.preferred_command, ["hook", "uninstall", "--scope", "project", "--json"], { cwd: project })).stdout,
      "hook uninstall",
    );
    const settingsAfter = parseJson(
      await readFile(path.join(project, ".claude", "settings.json"), "utf8"),
      "project .claude/settings.json after uninstall",
    );
    const remaining = (settingsAfter.hooks?.SessionStart ?? []).flatMap((group) =>
      (group.hooks ?? []).map((h) => h.command),
    );
    assert.deepEqual(remaining, [], "hook uninstall must remove the managed SessionStart hook");

    return {
      mode: spec.mode,
      package: `${manifest.name}@${manifest.version}`,
      files: contractReceipt.files.length,
      bins: Object.keys(manifest.bin),
      workflow: [
        "quickstart: home -> recipes -> current-format init -> attributed Task create/update -> query/home/status/history",
        "recipes",
        "init --create-only",
        "new",
        "doc update",
        "doc read",
        "doc history",
        "list",
        "explicit legacy init/reopen",
        "skill install/status/uninstall",
        "hook install/uninstall",
      ],
      identity: preferredIdentity,
      tarball: {
        path: meta.path ?? null,
        filename: meta.filename,
        sha256: meta.sha256 ?? (await fileSha256(tarball)),
        shasum: meta.shasum,
        integrity: meta.integrity,
        size: meta.size,
        unpacked_size: meta.unpackedSize,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Scratch-candidate mode (developer `--local`, PR-gate `--release`): builds+packs a FRESH candidate
 * in the scratch dir, then proves it. This is ordinary verification — NOT the production release
 * candidate. "Build/pack once" is a claim about the release-candidate command, not this mode.
 */
export async function verifyNpmPackage({ mode }) {
  const policy = verificationPolicy(mode);
  return runInstalledProof({
    mode: policy.mode,
    target: SUCCESSOR_TARGET,
    expectedChannel: policy.artifactChannel,
    async produce({ packDir, npmUserConfig, npmCache }) {
      const cleanBuildEnv = sanitizedNpmEnvironment(process.env, npmUserConfig, npmCache);
      await run(process.execPath, [path.join(repoRoot, "packages", "cli", "build.mjs"), policy.artifactChannel], {
        cwd: repoRoot,
        env: cleanBuildEnv,
      });
      const packed = await runNpm(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        { cwd: path.join(repoRoot, "packages", "cli"), npmUserConfig, npmCache },
      );
      const receipts = parseJson(packed.stdout, "npm pack");
      assert.equal(receipts.length, 1, "npm pack must produce exactly one tarball");
      const receipt = receipts[0];
      const tarball = path.join(packDir, receipt.filename);
      return {
        tarball,
        meta: {
          path: tarball,
          filename: receipt.filename,
          sha256: await fileSha256(tarball),
          shasum: receipt.shasum,
          integrity: receipt.integrity,
          size: receipt.size,
          unpackedSize: receipt.unpackedSize,
        },
      };
    },
  });
}

/**
 * Retained-artifact mode (`--tarball <path> [--manifest <candidate.json>]`): verifies an
 * ALREADY-PACKED tarball with NO build and NO pack. Contains, by construction, zero calls to
 * build.mjs or `npm pack` — the whole point of P5A's no-rebuild invariant. When a candidate
 * manifest is supplied its recorded SHA-256 must equal the tarball's actual bytes, so a swapped
 * or rebuilt artifact fails closed here before it can be staged.
 */
export async function verifyRetainedTarball({ tarball, manifest, targetsPath = DEFAULT_RELEASE_TARGETS_PATH }) {
  const tarballPath = path.resolve(tarball);
  // The manifest is MANDATORY (QA finding #2): it is the only thing that ties these exact bytes to
  // the staged candidate. Without it we could only prove "some valid npm-package tarball", which is
  // not the retained-artifact guarantee. Fail closed.
  if (!manifest) {
    throw new Error("verifyRetainedTarball requires a candidate manifest (the retained SHA cross-check anchor)");
  }
  await access(tarballPath, constants.R_OK).catch(() => {
    throw new Error(`retained tarball not found: ${tarballPath}`);
  });
  const actualSha = await fileSha256(tarballPath);
  const recorded = parseJson(await readFile(path.resolve(manifest), "utf8"), "candidate manifest");
  const targetId = recorded?.target;
  if (!targetId) throw new Error("candidate manifest requires an explicit target");
  const targetManifest = await loadReleaseTargets(targetsPath, {
    burnedFile: path.join(path.dirname(targetsPath), "burned-versions.json"),
    cliPackageFile: null,
  });
  if (recorded?.agreement?.release_targets_sha256) {
    assert.equal(
      await fileSha256(targetsPath),
      recorded.agreement.release_targets_sha256,
      "candidate manifest release-target agreement does not match release/targets.json",
    );
  }
  const target = targetManifest.targets[targetId];
  if (!target) throw new Error(`candidate manifest names unknown release target ${JSON.stringify(targetId)}`);
  const recordedSha = recorded?.tarball?.sha256;
  assert.equal(
    actualSha,
    recordedSha,
    `retained tarball SHA-256 ${actualSha} does not match candidate manifest ${recordedSha ?? "<missing>"}`,
  );
  assert.equal(recorded?.schema, RELEASE_CANDIDATE_SCHEMA, "retained candidate manifest schema mismatch");
  const tuple = assertAllowedTuple(targetManifest, {
    target: targetId,
    packageName: recorded?.package?.name,
    version: recorded?.version,
    tag: recorded?.tag,
  });
  assert.equal(recorded?.tarball?.version, tuple.version, "candidate tarball version does not match the reviewed tuple");
  assert.equal(recorded?.tarball?.filename, path.basename(tarballPath), "candidate tarball filename does not match the retained file");
  assert.equal(recorded.tarball.filename, tarballFilename(target, tuple.version), "candidate tarball filename does not match the reviewed tuple");
  assert.deepEqual(recorded?.build_identity?.package, { name: tuple.package, version: tuple.version }, "candidate build identity package does not match the reviewed tuple");
  assert.deepEqual(recorded?.build_identity?.source, recorded?.source, "candidate build identity source does not match candidate source");
  assert.deepEqual(recorded?.build_identity?.compatibility_contracts, recorded?.compatibility_contracts, "candidate compatibility contracts do not agree");
  assert.equal(
    recorded?.build_identity?.artifact?.channel,
    "npm-package",
    "a retained release candidate must carry the npm-package artifact channel",
  );
  const proof = await runInstalledProof({
    mode: "tarball",
    target,
    // A retained release candidate is always an npm-package build; the identity proof enforces it.
    expectedChannel: "npm-package",
    async produce() {
      return {
        tarball: tarballPath,
        meta: {
          path: tarballPath,
          filename: path.basename(tarballPath),
          sha256: actualSha,
          shasum: recorded?.tarball?.shasum ?? null,
          integrity: recorded?.tarball?.integrity ?? null,
          size: recorded?.tarball?.size ?? null,
          unpackedSize: recorded?.tarball?.unpacked_size ?? null,
        },
      };
    },
  });
  const expectedPackage = { name: tuple.package, version: tuple.version };
  assert.equal(proof.package, `${tuple.package}@${tuple.version}`, "installed package coordinate does not match the reviewed tuple");
  assert.deepEqual(proof?.identity?.identity?.package, expectedPackage, "embedded package identity does not match the reviewed tuple");
  assert.deepEqual(proof?.identity?.identity?.source, recorded.build_identity.source, "embedded source identity does not match the candidate build identity");
  assert.equal(proof?.identity?.identity?.artifact?.channel, recorded.build_identity.artifact.channel, "embedded artifact channel does not match the candidate build identity");
  assert.equal(proof?.identity?.identity?.artifact?.sha256, recorded.build_identity.artifact.sha256, "embedded artifact digest does not match the candidate build identity");
  assert.deepEqual(
    proof?.identity?.identity?.compatibility_contracts,
    recorded.build_identity.compatibility_contracts,
    "embedded compatibility contracts do not match the candidate build identity",
  );
  return proof;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseVerificationArgs(argv);
  const result =
    args.mode === "tarball"
      ? await verifyRetainedTarball({ tarball: args.tarball, manifest: args.manifest })
      : await verifyNpmPackage({ mode: args.mode });
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    const source = result.identity.identity.source;
    console.log(
      `verified ${result.mode} ${result.package}: ${result.files} files, zero runtime dependencies, ` +
        `bins ${result.bins.join("/")}, source commit=${source.commit ?? "unknown"} dirty=${source.dirty ?? "unknown"}, ` +
        "offline workflow passed",
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
