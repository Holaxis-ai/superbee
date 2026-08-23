import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicExportSpecifiers, resolvePackageExportTargets } from "./package-exports.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, cwd) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

function npmInvocation(args, env = process.env) {
  const npmCli = env.npm_execpath?.trim();
  if (!npmCli) {
    throw new Error("npm_execpath is required; run this proof through the repository's npm test:scripts gate");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

async function runNpm(args, cwd) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd);
}

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

const CORE_PACKAGE = "@superbee/core";
const INSTALLED_CONSUMER_BRANCHES = [
  { name: "import", conditions: ["node", "import"] },
  { name: "require", conditions: ["node", "require"] },
];

test("core export proof derives its consumer surface from the manifest", () => {
  const manifest = {
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./future": { types: "./dist/future.d.ts", default: "./dist/future.js" },
    },
  };
  assert.deepEqual(publicExportSpecifiers(manifest, CORE_PACKAGE), ["@superbee/core", "@superbee/core/future"]);
  assert.deepEqual(
    resolvePackageExportTargets(
      {
        exports: {
          "./conditional": {
            import: "./dist/import.js",
            require: "./dist/require.cjs",
            default: "./dist/default.js",
          },
        },
      },
      CORE_PACKAGE,
      ["node", "import"],
    )[0]?.target,
    "./dist/import.js",
  );
  assert.deepEqual(
    resolvePackageExportTargets(
      {
        exports: {
          "./conditional": {
            import: "./dist/import.js",
            require: "./dist/require.cjs",
            default: "./dist/default.js",
          },
        },
      },
      CORE_PACKAGE,
      ["node", "require"],
    )[0]?.target,
    "./dist/require.cjs",
  );
});

test("npm is launched shell-free through its CLI JavaScript path", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(npmInvocation(["pack", "--json"], { npm_execpath: npmCli }), {
    command: process.execPath,
    args: [npmCli, "pack", "--json"],
  });
  assert.throws(() => npmInvocation([], {}), /npm_execpath is required/);
});

test("packed core installs, typechecks, and runs outside the monorepo", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentstate-lite-core-consumer-"));
  const packDir = path.join(scratch, "pack");
  try {
    await mkdir(packDir);
    await runNpm(["run", "build", "-w", "@superbee/core"], repoRoot);
    const packed = await runNpm(
      ["pack", "-w", "@superbee/core", "--json", "--pack-destination", packDir],
      repoRoot,
    );
    const [receipt] = JSON.parse(packed.stdout);
    const paths = receipt.files.map((file) => file.path).sort();
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.every((file) => file === "package.json" || file.startsWith("dist/")));

    await writeFile(
      path.join(scratch, "package.json"),
      JSON.stringify({ name: "core-external-proof", private: true, type: "module" }, null, 2),
    );
    await runNpm(
      [
        "install",
        // prefer-offline, not offline: resolving core's real dependency range (gray-matter)
        // needs a registry packument on a cold cache — `npm ci` caches tarballs by exact URL,
        // never packuments, so a fresh machine/CI runner cannot resolve ranges fully offline.
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--no-save",
        path.join(packDir, receipt.filename),
      ],
      scratch,
    );

    const installed = path.join(scratch, "node_modules", "@superbee", "core");
    const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    const publicExports = publicExportSpecifiers(installedManifest, CORE_PACKAGE);
    assert.ok(publicExports.length > 1, "fixture must exercise root and subpath exports");
    const resolvedBranches = INSTALLED_CONSUMER_BRANCHES.map((branch) => ({
      ...branch,
      exports: resolvePackageExportTargets(installedManifest, CORE_PACKAGE, branch.conditions),
    }));

    await writeFile(
      path.join(scratch, "consumer.ts"),
      `${publicExports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`,
    );
    await writeFile(
      path.join(scratch, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      scratch,
    );

    await writeFile(
      path.join(scratch, "consumer.mjs"),
      `import { createRequire } from "node:module";
const branches = ${JSON.stringify(resolvedBranches)};
for (const specifier of branches.find((branch) => branch.name === "import").exports.map((entry) => entry.specifier)) {
  const loaded = await import(specifier);
  if (Object.keys(loaded).length === 0) throw new Error(specifier + " resolved to an empty module");
}
const require = createRequire(import.meta.url);
for (const specifier of branches.find((branch) => branch.name === "require").exports.map((entry) => entry.specifier)) {
  const loaded = require(specifier);
  if (Object.keys(loaded).length === 0) throw new Error(specifier + " resolved to an empty module");
}
`,
    );
    await run(process.execPath, ["consumer.mjs"], scratch);

    assert.equal(installedManifest.private, true);
    assert.deepEqual(installedManifest.files, ["dist"]);
    const installedFiles = await filesUnder(installed);
    assert.ok(installedFiles.every((file) => file === "package.json" || file.startsWith("dist/")));
    for (const branch of resolvedBranches) {
      for (const entry of branch.exports) {
        assert.ok(
          installedFiles.includes(entry.target.replace(/^\.\//, "")),
          `${branch.name} export target is missing from package: ${entry.target}`,
        );
      }
    }

    const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
    for (const file of installedFiles.filter((name) => /\.(?:js|d\.ts)$/.test(name))) {
      const source = await readFile(path.join(installed, file), "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        assert.ok(!specifier.startsWith("@superbee/"), `${file} imports workspace package ${specifier}`);
        assert.ok(!/(^|\/)src(?:\/|$)/.test(specifier), `${file} imports source path ${specifier}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
