import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const usage = "usage: verify-runtime-libraries.mjs <core.tgz> <server.tgz>";

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath?.trim();
  if (!npmCli) throw new Error("npm_execpath is required; run this verifier through npm");
  return [process.execPath, [npmCli, ...args]];
}

async function runNpm(args, cwd) {
  const [command, commandArgs] = npmInvocation(args);
  return execFileAsync(command, commandArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyRuntimeLibraries(coreInput, serverInput) {
  if (!coreInput || !serverInput) throw new Error(usage);
  const coreTarball = path.resolve(coreInput);
  const serverTarball = path.resolve(serverInput);
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-runtime-libraries-"));
  try {
    await writeFile(
      path.join(scratch, "package.json"),
      `${JSON.stringify({
        name: "runtime-libraries-verifier",
        private: true,
        type: "module",
        dependencies: {
          "@superbee/core": `file:${coreTarball}`,
          "@superbee/server": `file:${serverTarball}`,
        },
      }, null, 2)}\n`,
    );
    await runNpm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
      scratch,
    );

    const scope = path.join(scratch, "node_modules", "@superbee");
    const [coreManifest, serverManifest] = await Promise.all([
      readFile(path.join(scope, "core", "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(scope, "server", "package.json"), "utf8").then(JSON.parse),
    ]);
    assert.equal((await lstat(path.join(scope, "core"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(scope, "server"))).isSymbolicLink(), false);
    assert.equal(coreManifest.name, "@superbee/core");
    assert.equal(serverManifest.name, "@superbee/server");
    assert.equal(coreManifest.private, undefined);
    assert.equal(serverManifest.private, undefined);
    assert.equal(coreManifest.version, serverManifest.version, "library versions must stay synchronized");
    assert.equal(
      serverManifest.dependencies?.["@superbee/core"],
      coreManifest.version,
      "server must depend on the exact matching core version",
    );
    for (const manifest of [coreManifest, serverManifest]) {
      assert.deepEqual(manifest.publishConfig, {
        access: "restricted",
        registry: "https://registry.npmjs.org/",
      });
      assert.match(manifest.scripts?.prepublishOnly ?? "", /process\.exit\(1\)/);
    }

    await writeFile(
      path.join(scratch, "worker-entry.js"),
      `import { writeDocVersioned } from "@superbee/core/engine";
import { VersionConflict } from "@superbee/core/storage";
import { RemoteBackend } from "@superbee/core/remote";
import { createRouter, resolveWireRequest } from "@superbee/server/router";
export const runtime = { createRouter, resolveWireRequest, writeDocVersioned, VersionConflict, RemoteBackend };
`,
    );
    const result = await build({
      absWorkingDir: scratch,
      entryPoints: ["worker-entry.js"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.outputFiles[0].text.includes("resolveWireRequest"));

    return {
      version: coreManifest.version,
      core: { path: coreTarball, sha256: await sha256(coreTarball) },
      server: { path: serverTarball, sha256: await sha256(serverTarball) },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error(usage);
  process.stdout.write(`${JSON.stringify(await verifyRuntimeLibraries(args[0], args[1]), null, 2)}\n`);
}
