import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
const OWNED_SOURCE_DIRECTORIES = [
  "scripts",
  "packages/cli/scripts",
  "packages/mcp-app/scripts",
];
const OWNED_PACKAGE_ENTRYPOINTS = [
  "packages/cli/build.mjs",
];
const LEGACY_MAIN_GUARD_PATTERNS = [
  /process\.argv\[1\][\s\S]{0,200}fileURLToPath\(import\.meta\.url\)/,
  /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\s*\?\?\s*""\)\.href/,
];
const SHARED_MAIN_GUARD_PATTERN = /\bisMainModule\(import\.meta\.url\b/;
const DEFAULT_ENV = {
  ...process.env,
  ASLITE_NO_UPDATE_CHECK: "1",
  AGENTSTATE_LITE_NO_AUTOPULL: "1",
};

const OWNED_ENTRYPOINT_PROBES = [
  {
    relativePath: "packages/cli/build.mjs",
    args: () => [],
    expected: { code: 1, stderr: /usage: buildCli\(local-dev\|npm-package\)/ },
  },
  {
    relativePath: "packages/mcp-app/scripts/build-view.mjs",
    args: () => ["--unexpected"],
    expected: { code: 2, stderr: /usage: build-view\.mjs/ },
  },
  {
    relativePath: "scripts/migrate-legacy-view-names.mjs",
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

const OWNED_ENTRYPOINT_PATHS = OWNED_ENTRYPOINT_PROBES.map(({ relativePath }) => relativePath).sort();

async function readOwnedEntrypointSources() {
  const owned = [];
  for (const relativeDir of OWNED_SOURCE_DIRECTORIES) {
    const directory = path.join(repoRoot, relativeDir);
    const entries = (await readdir(directory))
      .filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs"))
      .map((entry) => path.posix.join(relativeDir, entry));
    owned.push(...entries);
  }
  owned.push(...OWNED_PACKAGE_ENTRYPOINTS);
  return owned.sort();
}

async function discoverGuardedEntrypoints() {
  const discovered = [];
  for (const relativePath of await readOwnedEntrypointSources()) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    if (SHARED_MAIN_GUARD_PATTERN.test(source) || LEGACY_MAIN_GUARD_PATTERNS.some((pattern) => pattern.test(source))) {
      discovered.push(relativePath);
    }
  }
  return discovered.sort();
}

async function createLinkedEntrypointFixture(t, relativePath) {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-entrypoint-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directPath = path.join(repoRoot, relativePath);
  const linkedPath = path.join(scratch, path.basename(relativePath));
  await symlink(directPath, linkedPath);
  return { scratch, directPath, linkedPath };
}

async function runNodeModule(modulePath, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [modulePath, ...args], {
      cwd,
      env: DEFAULT_ENV,
      maxBuffer: 20 * 1024 * 1024,
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

function assertResultMatches(relativePath, result, expected) {
  assert.equal(result.code, expected.code, `${relativePath}: exit code`);
  if (expected.stdout) assert.match(result.stdout, expected.stdout, `${relativePath}: stdout`);
  if (expected.stderr) assert.match(result.stderr, expected.stderr, `${relativePath}: stderr`);
}

test("repository-wide guarded entrypoint discovery matches the behavioral probe manifest", async () => {
  const discovered = await discoverGuardedEntrypoints();
  assert.deepEqual(discovered, OWNED_ENTRYPOINT_PATHS);

  for (const relativePath of discovered) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.match(source, SHARED_MAIN_GUARD_PATTERN, relativePath);
    assert.doesNotMatch(source, /await isMainModule\(import\.meta\.url\)/, `${relativePath} should not use entrypoint-only top-level await`);
    for (const pattern of LEGACY_MAIN_GUARD_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${relativePath} should not carry a local main guard`);
    }
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

test("every owned guarded entrypoint behaves the same directly and through a symlink from a non-repository cwd", async (t) => {
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

test("every owned guarded entrypoint imports without running main", async (t) => {
  for (const probe of OWNED_ENTRYPOINT_PROBES) {
    const { scratch, directPath } = await createLinkedEntrypointFixture(t, probe.relativePath);
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
