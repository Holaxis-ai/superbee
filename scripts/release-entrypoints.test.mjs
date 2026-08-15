import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createIsMainModule, isMainModule } from "./is-main-module.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const representativeCli = path.join(repoRoot, "scripts", "release-resolve-target.mjs");
const secondEntrypoint = path.join(repoRoot, "scripts", "rename-literal-inventory.mjs");
const OWNED_SOURCE_SURFACE_DIRECTORIES = [
  "scripts",
  "packages/cli/scripts",
  "packages/mcp-app/scripts",
];
const OWNED_SOURCE_SURFACE_EXTRAS = [
  "packages/cli/build.mjs",
];
const PACKAGE_SCRIPT_AUTHORITY_FILES = [
  "package.json",
  "packages/cli/package.json",
  "packages/mcp-app/package.json",
];
const EXPLICIT_OPERATOR_EXECUTABLE_PATHS = [
  "scripts/migrate-legacy-view-names.mjs",
  "scripts/rename-literal-inventory.mjs",
  "scripts/release-inspect.mjs",
  "scripts/release-reconcile.mjs",
];
const LEGACY_MAIN_GUARD_PATTERNS = [
  /process\.argv\[1\][\s\S]{0,200}fileURLToPath\(import\.meta\.url\)/,
  /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\s*\?\?\s*""\)\.href/,
];
const SHARED_MAIN_GUARD_PATTERN = /\bisMainModule\(import\.meta\.url\b/;
const NODE_SOURCE_ENTRYPOINT_PATTERN = /\bnode\s+(?:"([^"\n]+?\.mjs)"|'([^'\n]+?\.mjs)'|([^\s"'`()|&;]+?\.mjs))/g;
const STATIC_MODULE_SPECIFIER_PATTERN = /\b(?:import|export)\s+(?:[^"'`\n;]*?\s+from\s+)?["']([^"'`\n]+)["']/g;
const MAX_BUFFER = 20 * 1024 * 1024;
const DISALLOWED_MUTATION_PERMISSION_FLAG_PREFIXES = [
  "--allow-fs-write",
  "--allow-child-process",
  "--allow-worker",
  "--allow-net",
  "--allow-addons",
  "--allow-wasi",
  "--allow-inspector",
];
const DEFAULT_ENV = {
  ...process.env,
  ASLITE_NO_UPDATE_CHECK: "1",
  AGENTSTATE_LITE_NO_AUTOPULL: "1",
};
let coreDistBuildPromise;

const OWNED_ENTRYPOINT_PROBES = [
  {
    relativePath: "packages/cli/build.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: buildCli\(local-dev\|npm-package\)/ },
  },
  {
    relativePath: "packages/cli/scripts/gen-skill.mjs",
    args: () => ["--unexpected"],
    expected: { code: 2, stderr: /usage: node scripts\/gen-skill\.mjs \[--check\]/ },
  },
  {
    relativePath: "packages/mcp-app/scripts/build-view.mjs",
    args: () => ["--unexpected"],
    expected: { code: 2, stderr: /usage: build-view\.mjs/ },
  },
  {
    relativePath: "scripts/migrate-legacy-view-names.mjs",
    setup: async () => {
      await ensureCoreDistPrerequisite();
    },
    args: () => [],
    expected: { code: 2, stderr: /usage: node scripts\/migrate-legacy-view-names\.mjs --dir/ },
  },
  {
    relativePath: "scripts/mutation-survivors.mjs",
    args: ({ scratch }) => [path.join(scratch, "mutation.json")],
    setup: async ({ scratch }) => {
      await writeFile(
        path.join(scratch, "mutation.json"),
        `${JSON.stringify({
          files: {
            "src/example.ts": {
              source: "export const answer = 42;\n",
              mutants: [],
            },
          },
        })}\n`,
      );
    },
    expected: { code: 0, stdout: /score n\/a \(no mutants\)/ },
  },
  {
    relativePath: "scripts/prepublish-guard.mjs",
    args: () => [],
    expected: { code: 1, stderr: /prepublishOnly refused:/ },
  },
  {
    relativePath: "scripts/rename-literal-inventory.mjs",
    args: () => ["--check"],
    expected: { code: 0, stdout: /rename literal inventory:/ },
  },
  {
    relativePath: "scripts/release-audit-tags.mjs",
    args: ({ scratch }) => ["--phase-file", path.join(scratch, "phase.json")],
    setup: async ({ scratch }) => {
      await writeFile(path.join(scratch, "phase.json"), '{"phase":"not-a-real-phase"}\n');
    },
    expected: { code: 1, stderr: /phase must be one of/ },
  },
  {
    relativePath: "scripts/release-candidate.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: release-candidate\.mjs --target <target> --tag v<version> --commit <40-hex>/ },
  },
  {
    relativePath: "scripts/release-emit-receipt.mjs",
    args: () => [],
    expected: { code: 1, stderr: /missing --run-id/ },
  },
  {
    relativePath: "scripts/release-inspect.mjs",
    args: () => ["--unknown"],
    expected: { code: 1, stderr: /unknown argument "--unknown"/ },
  },
  {
    relativePath: "scripts/release-reconcile.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: release-reconcile\.mjs --to <state> --receipt <file\|->/ },
  },
  {
    relativePath: "scripts/release-resolve-target.mjs",
    args: () => ["--target", "bridge", "--json"],
    expected: { code: 0, stdout: /"target":"bridge"/ },
  },
  {
    relativePath: "scripts/release-run-operations.mjs",
    args: () => ["--op", "reject", "--stage-id", "STAGE-1"],
    expected: { code: 0, stdout: /npm stage reject STAGE-1/ },
  },
  {
    relativePath: "scripts/release-verify-chain.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: release-verify-chain\.mjs stage-id\|capture-draft\|verify-finalizer/ },
  },
  {
    relativePath: "scripts/release-verify-ordering.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: release-verify-ordering\.mjs assets\|verify\|plan\|apply\|final/ },
  },
  {
    relativePath: "scripts/release-verify-registry.mjs",
    args: () => [],
    expected: { code: 1, stderr: /missing --version/ },
  },
  {
    relativePath: "scripts/verify-npm-package.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: verify-npm-package\.mjs/ },
  },
];

const POSITIVE_EXECUTABLE_ENTRYPOINT_PATHS = OWNED_ENTRYPOINT_PROBES.map(({ relativePath }) => relativePath).sort();

function toPosixRelative(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

async function readOwnedSourceModules() {
  const owned = [];
  for (const relativeDir of OWNED_SOURCE_SURFACE_DIRECTORIES) {
    const directory = path.join(repoRoot, relativeDir);
    const entries = (await readdir(directory))
      .filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs"))
      .map((entry) => path.posix.join(relativeDir, entry));
    owned.push(...entries);
  }
  owned.push(...OWNED_SOURCE_SURFACE_EXTRAS);
  return owned.sort();
}

function parseNodeEntrypoints(text, baseDirectory) {
  const discovered = new Set();
  for (const match of text.matchAll(NODE_SOURCE_ENTRYPOINT_PATTERN)) {
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) continue;
    discovered.add(toPosixRelative(path.resolve(baseDirectory, rawPath)));
  }
  return discovered;
}

async function deriveDeclaredExecutableEntrypoints(ownedSourceModules) {
  const ownedSet = new Set(ownedSourceModules);
  const declared = new Set();

  for (const relativePath of PACKAGE_SCRIPT_AUTHORITY_FILES) {
    const packageJsonPath = path.join(repoRoot, relativePath);
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    for (const command of Object.values(packageJson.scripts ?? {})) {
      if (typeof command !== "string") continue;
      for (const entrypoint of parseNodeEntrypoints(command, path.dirname(packageJsonPath))) {
        if (ownedSet.has(entrypoint)) declared.add(entrypoint);
      }
    }
  }

  const workflowDirectory = path.join(repoRoot, ".github", "workflows");
  for (const workflowFile of (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"))) {
    const workflowPath = path.join(workflowDirectory, workflowFile);
    const text = (await readFile(workflowPath, "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const entrypoint of parseNodeEntrypoints(text, repoRoot)) {
      if (ownedSet.has(entrypoint)) declared.add(entrypoint);
    }
  }

  return [...declared].sort();
}

async function deriveExecutableAuthority() {
  const ownedSourceModules = await readOwnedSourceModules();
  const declaredExecutableEntrypoints = await deriveDeclaredExecutableEntrypoints(ownedSourceModules);
  const positiveExecutableEntrypoints = [...new Set([...declaredExecutableEntrypoints, ...EXPLICIT_OPERATOR_EXECUTABLE_PATHS])].sort();
  const positiveSet = new Set(positiveExecutableEntrypoints);
  const pureModuleCandidates = ownedSourceModules.filter((relativePath) => !positiveSet.has(relativePath));
  return {
    ownedSourceModules,
    declaredExecutableEntrypoints,
    positiveExecutableEntrypoints,
    pureModuleCandidates,
  };
}

async function ensureCoreDistPrerequisite() {
  coreDistBuildPromise ??= execFileAsync("npm", ["run", "build", "--workspace=@superbee/core"], {
    cwd: repoRoot,
    env: DEFAULT_ENV,
    maxBuffer: MAX_BUFFER,
  });
  await coreDistBuildPromise;
}

async function createLinkedEntrypointFixture(t, relativePath) {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-entrypoint-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directPath = path.join(repoRoot, relativePath);
  const linkedPath = path.join(scratch, path.basename(relativePath));
  await symlink(directPath, linkedPath);
  return { scratch, directPath, linkedPath };
}

async function createRepoScratchDirectory(t, prefix = ".tmp-entrypoint-permission-") {
  const scratch = await mkdtemp(path.join(repoRoot, prefix));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return scratch;
}

async function createExternalDependencyFixture(t) {
  const fixtureBaseDirectory = await realpath(path.dirname(repoRoot));
  const fixtureRoot = await mkdtemp(path.join(fixtureBaseDirectory, "superbee-external-deps-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const linkedNodeModules = path.join(fixtureRoot, "node_modules");
  await symlink(await realpath(path.join(repoRoot, "node_modules")), linkedNodeModules);
  return {
    fixtureRoot,
    linkedNodeModules,
  };
}

function parseStaticModuleSpecifiers(source) {
  return [...source.matchAll(STATIC_MODULE_SPECIFIER_PATTERN)].map((match) => match[1]);
}

function isBareModuleSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");
}

function findDependencyReadRoot(resolvedPath) {
  const { root } = path.parse(resolvedPath);
  const relativeParts = resolvedPath.slice(root.length).split(path.sep).filter(Boolean);
  const nodeModulesIndex = relativeParts.indexOf("node_modules");
  if (nodeModulesIndex === -1) return null;
  return path.join(root, ...relativeParts.slice(0, nodeModulesIndex + 1));
}

async function derivePureImportReadRoots(ownerRoot, entryModulePaths) {
  const canonicalOwnerRoot = await realpath(ownerRoot);
  const discoveredRoots = new Set([canonicalOwnerRoot]);
  const pending = [...entryModulePaths];
  const visited = new Set();

  while (pending.length > 0) {
    const nextModulePath = pending.pop();
    const canonicalModulePath = await realpath(nextModulePath);
    if (visited.has(canonicalModulePath)) continue;
    visited.add(canonicalModulePath);

    const source = await readFile(canonicalModulePath, "utf8");
    for (const specifier of parseStaticModuleSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;

      if (isBareModuleSpecifier(specifier)) {
        const resolvedPath = createRequire(canonicalModulePath).resolve(specifier);
        const dependencyReadRoot = findDependencyReadRoot(await realpath(resolvedPath));
        if (dependencyReadRoot !== null) discoveredRoots.add(dependencyReadRoot);
        continue;
      }

      const resolvedLocalPath = path.resolve(path.dirname(canonicalModulePath), specifier);
      if (resolvedLocalPath === canonicalOwnerRoot || resolvedLocalPath.startsWith(`${canonicalOwnerRoot}${path.sep}`)) {
        pending.push(resolvedLocalPath);
      }
    }
  }

  return [...discoveredRoots].sort();
}

function buildPureImportNodeArgs(readRoots, runnerPath) {
  return [
    "--permission",
    ...readRoots.map((root) => `--allow-fs-read=${root}`),
    runnerPath,
  ];
}

async function runNodeProcess(nodeArgs, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, nodeArgs, {
      cwd,
      env: DEFAULT_ENV,
      maxBuffer: MAX_BUFFER,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
    throw error;
  }
}

async function runNodeModule(modulePath, args, cwd, { nodeArgs = [] } = {}) {
  return runNodeProcess([...nodeArgs, modulePath, ...args], cwd);
}

function assertResultMatches(relativePath, result, expected) {
  assert.equal(result.code, expected.code, `${relativePath}: exit code`);
  if (expected.stdout) assert.match(result.stdout, expected.stdout, `${relativePath}: stdout`);
  if (expected.stderr) assert.match(result.stderr, expected.stderr, `${relativePath}: stderr`);
}

test("positive executable authority comes from declarations plus explicit operator entries", async () => {
  const authority = await deriveExecutableAuthority();

  assert.deepEqual(authority.positiveExecutableEntrypoints, POSITIVE_EXECUTABLE_ENTRYPOINT_PATHS);
  assert.deepEqual(
    authority.ownedSourceModules,
    [...authority.positiveExecutableEntrypoints, ...authority.pureModuleCandidates].sort(),
  );
  assert.deepEqual(authority.declaredExecutableEntrypoints, [
    "packages/cli/build.mjs",
    "packages/cli/scripts/gen-skill.mjs",
    "packages/mcp-app/scripts/build-view.mjs",
    "scripts/mutation-survivors.mjs",
    "scripts/prepublish-guard.mjs",
    "scripts/release-audit-tags.mjs",
    "scripts/release-candidate.mjs",
    "scripts/release-emit-receipt.mjs",
    "scripts/release-resolve-target.mjs",
    "scripts/release-run-operations.mjs",
    "scripts/release-verify-chain.mjs",
    "scripts/release-verify-ordering.mjs",
    "scripts/release-verify-registry.mjs",
    "scripts/verify-npm-package.mjs",
  ]);

  for (const relativePath of authority.positiveExecutableEntrypoints) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.match(source, SHARED_MAIN_GUARD_PATTERN, relativePath);
    assert.doesNotMatch(
      source,
      /await isMainModule\(import\.meta\.url\)/,
      `${relativePath} should not use entrypoint-only top-level await`,
    );
    for (const pattern of LEGACY_MAIN_GUARD_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${relativePath} should not carry a local main guard`);
    }
  }
});

test("pure import runner requires the Node permission boundary and grants no mutation capabilities", async (t) => {
  const { pureModuleCandidates } = await deriveExecutableAuthority();
  const readRoots = await derivePureImportReadRoots(
    repoRoot,
    pureModuleCandidates.map((relativePath) => path.join(repoRoot, relativePath)),
  );
  const scratch = await createRepoScratchDirectory(t);
  const runnerPath = path.join(scratch, "permission-introspect.mjs");
  await writeFile(
    runnerPath,
    `process.stdout.write(JSON.stringify({
  execArgv: process.execArgv,
  permissionApi: typeof process.permission?.has,
  readRoots: ${JSON.stringify(readRoots)}.map((root) => ({ root, allowed: process.permission?.has("fs.read", root) })),
  permissions: {
    cwdRead: process.permission?.has("fs.read", process.cwd()),
    cwdWrite: process.permission?.has("fs.write", process.cwd()),
    child: process.permission?.has("child"),
    worker: process.permission?.has("worker"),
    net: process.permission?.has("net"),
    addons: process.permission?.has("addons"),
    wasi: process.permission?.has("wasi"),
    inspector: process.permission?.has("inspector"),
  },
}));\n`,
  );

  const result = await runNodeProcess(buildPureImportNodeArgs(readRoots, runnerPath), scratch);
  assert.equal(result.code, 0, "pure import runner must execute under a supported Node permission model");
  assert.equal(result.stderr, "");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.permissionApi, "function", "runtime must expose process.permission.has under the pure import boundary");
  assert.deepEqual(payload.execArgv, ["--permission", ...readRoots.map((root) => `--allow-fs-read=${root}`)]);
  for (const prefix of DISALLOWED_MUTATION_PERMISSION_FLAG_PREFIXES) {
    assert.equal(
      payload.execArgv.some((value) => value === prefix || value.startsWith(`${prefix}=`)),
      false,
      `pure import runner must not grant ${prefix}`,
    );
  }
  assert.deepEqual(
    payload.readRoots,
    readRoots.map((root) => ({ root, allowed: true })),
    "pure import runner must grant exactly the derived canonical read roots",
  );
  assert.deepEqual(payload.permissions, {
    cwdRead: true,
    cwdWrite: false,
    child: false,
    worker: false,
    net: false,
    addons: false,
    wasi: false,
    inspector: false,
  });
});

test("pure import runner denies silent filesystem mutation before the sentinel", async (t) => {
  const scratch = await createRepoScratchDirectory(t);
  const markerPath = path.join(scratch, "silent-marker.txt");
  const probePath = path.join(scratch, "silent-write-probe.mjs");
  const runnerPath = path.join(scratch, "silent-write-runner.mjs");
  await writeFile(
    probePath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "laundered\\n");\n`,
  );
  await writeFile(
    runnerPath,
    `import ${JSON.stringify(pathToFileURL(probePath).href)};
process.stdout.write("IMPORTED\\n");\n`,
  );

  const result = await runNodeProcess(buildPureImportNodeArgs([repoRoot], runnerPath), scratch);
  assert.equal(result.code, 1, "silent mutation must fail under the pure import permission boundary");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ERR_ACCESS_DENIED|FileSystemWrite|--allow-fs-write/);
  await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
});

test("pure import runner permits canonical dependency roots through an external node_modules symlink without granting writes", async (t) => {
  const { fixtureRoot } = await createExternalDependencyFixture(t);
  const markerPath = path.join(fixtureRoot, "external-marker.txt");
  const pureModulePath = path.join(fixtureRoot, "import-esbuild.mjs");
  const pureRunnerPath = path.join(fixtureRoot, "import-esbuild-runner.mjs");
  await writeFile(
    pureModulePath,
    `import { build } from "esbuild";
if (typeof build !== "function") {
  throw new Error("esbuild build export missing");
}
`,
  );
  await writeFile(
    pureRunnerPath,
    `import ${JSON.stringify(pathToFileURL(pureModulePath).href)};
process.stdout.write("IMPORTED\\n");\n`,
  );

  const readRoots = await derivePureImportReadRoots(fixtureRoot, [pureModulePath]);
  assert.deepEqual(readRoots, [
    await realpath(fixtureRoot),
    await realpath(path.join(repoRoot, "node_modules")),
  ].sort());

  const pureImported = await runNodeProcess(buildPureImportNodeArgs(readRoots, pureRunnerPath), fixtureRoot);
  assert.deepEqual(pureImported, { code: 0, stdout: "IMPORTED\n", stderr: "" });

  const silentWriteModulePath = path.join(fixtureRoot, "import-esbuild-and-write.mjs");
  const silentWriteRunnerPath = path.join(fixtureRoot, "import-esbuild-and-write-runner.mjs");
  await writeFile(
    silentWriteModulePath,
    `import { build } from "esbuild";
import { writeFileSync } from "node:fs";
if (typeof build !== "function") {
  throw new Error("esbuild build export missing");
}
writeFileSync(${JSON.stringify(markerPath)}, "laundered\\n");
`,
  );
  await writeFile(
    silentWriteRunnerPath,
    `import ${JSON.stringify(pathToFileURL(silentWriteModulePath).href)};
process.stdout.write("IMPORTED\\n");\n`,
  );

  const silentWriteResult = await runNodeProcess(buildPureImportNodeArgs(readRoots, silentWriteRunnerPath), fixtureRoot);
  assert.equal(silentWriteResult.code, 1);
  assert.equal(silentWriteResult.stdout, "");
  assert.match(silentWriteResult.stderr, /ERR_ACCESS_DENIED|FileSystemWrite|--allow-fs-write/);
  await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
});

test("pure-module complement imports inertly and carries no entrypoint authority", async (t) => {
  const { pureModuleCandidates } = await deriveExecutableAuthority();
  const readRoots = await derivePureImportReadRoots(
    repoRoot,
    pureModuleCandidates.map((relativePath) => path.join(repoRoot, relativePath)),
  );

  for (const relativePath of pureModuleCandidates) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(source, SHARED_MAIN_GUARD_PATTERN, `${relativePath} should not use the shared main guard`);
    for (const pattern of LEGACY_MAIN_GUARD_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${relativePath} should not carry a local main guard`);
    }

    const scratch = await createRepoScratchDirectory(t);
    const directPath = path.join(repoRoot, relativePath);
    const runnerPath = path.join(scratch, `pure-import-${path.basename(relativePath)}`);
    await writeFile(
      runnerPath,
      `import ${JSON.stringify(pathToFileURL(directPath).href)};\nprocess.stdout.write("IMPORTED\\n");\n`,
    );
    const imported = await runNodeProcess(buildPureImportNodeArgs(readRoots, runnerPath), scratch);
    assert.deepEqual(
      imported,
      { code: 0, stdout: "IMPORTED\n", stderr: "" },
      `${relativePath}: pure-module complement must import inertly`,
    );
  }
});

test("isMainModule distinguishes direct execution, imports, and symlinked execution", async (t) => {
  const moduleUrl = pathToFileURL(representativeCli).href;
  assert.equal(isMainModule(moduleUrl, { argv1: representativeCli }), true);
  assert.equal(isMainModule(moduleUrl, { argv1: path.join(repoRoot, "package.json") }), false);
  assert.throws(() => isMainModule(moduleUrl, { argv1: undefined }), /non-empty path/);

  const { linkedPath } = await createLinkedEntrypointFixture(t, "scripts/release-resolve-target.mjs");
  assert.equal(isMainModule(moduleUrl, { argv1: linkedPath }), true);
});

test("isMainModule caches the default process entrypoint identity once per process", () => {
  const calls = [];
  const authority = createIsMainModule({
    getArgv1: () => representativeCli,
    realpathImpl: (value) => {
      calls.push(value);
      return path.resolve(value);
    },
  });

  authority(pathToFileURL(secondEntrypoint).href);
  authority(pathToFileURL(secondEntrypoint).href);

  assert.deepEqual(calls, [representativeCli, secondEntrypoint, secondEntrypoint]);
});

test("isMainModule keeps invocation and module failures fail-closed and distinct", () => {
  assert.throws(
    () =>
      isMainModule(pathToFileURL(secondEntrypoint).href, {
        argv1: representativeCli,
        realpathImpl(value) {
          if (value === representativeCli) throw new Error("access denied");
          return value;
        },
      }),
    /entrypoint authority could not resolve invocation path: access denied/,
  );

  assert.throws(
    () =>
      isMainModule(pathToFileURL(secondEntrypoint).href, {
        argv1: representativeCli,
        realpathImpl(value) {
          if (value === secondEntrypoint) throw new Error("module vanished");
          return value;
        },
      }),
    /entrypoint authority could not resolve module path: module vanished/,
  );
});

test("isMainModule leaves invalid module URLs as programming errors", () => {
  assert.throws(
    () => isMainModule("https://example.com/not-a-file.mjs", { argv1: representativeCli }),
    /must be a file URL|scheme/,
  );
});

test("library-bearing entrypoints remain synchronously requireable when Node supports require(esm)", async (t) => {
  if (!process.features?.require_module) {
    t.skip("current Node runtime does not support synchronous require(esm)");
    return;
  }

  for (const [relativePath, exportName] of [
    ["packages/cli/build.mjs", "buildCli"],
    ["packages/mcp-app/scripts/build-view.mjs", "buildMcpViewHtml"],
  ]) {
    const required = await execFileAsync(
      process.execPath,
      [
        "--input-type=commonjs",
        "--eval",
        `const mod = require(${JSON.stringify(path.join(repoRoot, relativePath))}); console.log(typeof mod.${exportName});`,
      ],
      { cwd: repoRoot, env: DEFAULT_ENV },
    );
    assert.equal(required.stdout.trim(), "function", relativePath);
  }
});

test("every positive executable behaves the same directly and through a symlink from a non-repository cwd", async (t) => {
  for (const probe of OWNED_ENTRYPOINT_PROBES) {
    const { scratch, directPath, linkedPath } = await createLinkedEntrypointFixture(t, probe.relativePath);
    await probe.setup?.({ scratch });
    const args = probe.args({ scratch });

    const direct = await runNodeModule(directPath, args, scratch);
    const linked = await runNodeModule(linkedPath, args, scratch);

    assertResultMatches(probe.relativePath, direct, probe.expected);
    assert.deepEqual(linked, direct, `${probe.relativePath}: direct and symlinked execution should be observably identical`);
  }
});

test("every positive executable imports without running main", async (t) => {
  for (const probe of OWNED_ENTRYPOINT_PROBES) {
    const { scratch, directPath } = await createLinkedEntrypointFixture(t, probe.relativePath);
    await probe.setup?.({ scratch });
    const runnerPath = path.join(scratch, `import-${path.basename(probe.relativePath)}`);
    await writeFile(
      runnerPath,
      `import ${JSON.stringify(pathToFileURL(directPath).href)};\nprocess.stdout.write("IMPORTED\\n");\n`,
    );
    const imported = await runNodeModule(runnerPath, [], scratch);
    assert.deepEqual(
      imported,
      { code: 0, stdout: "IMPORTED\n", stderr: "" },
      `${probe.relativePath}: importing should stay inert until the runner sentinel`,
    );
  }
});
