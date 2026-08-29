import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageRoot = path.join(repoRoot, "packages", "cli");

export function publishedManifest(source, readme) {
  return {
    ...source,
    // `npm stage publish <tarball>` does not read README.md while deriving registry metadata.
    // Carry the exact page bytes in the packed manifest so direct tarball staging stays exact and
    // npm's package page receives the same README that users install.
    readme,
    readmeFilename: "README.md",
  };
}

export async function packNpmPackage({
  packageRoot = cliPackageRoot,
  packDestination,
  npmExecPath = process.env.npm_execpath,
  env = process.env,
}) {
  if (!packDestination) throw new Error("packDestination is required");
  if (!npmExecPath?.trim()) {
    throw new Error("npm_execpath is required; run this packer through npm from the repository root");
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-npm-package-stage-"));
  const stagedPackage = path.join(scratch, "package");
  const destination = path.resolve(packDestination);
  try {
    await cp(packageRoot, stagedPackage, {
      recursive: true,
      filter(source) {
        const relative = path.relative(packageRoot, source);
        return relative === "" || !relative.split(path.sep).includes("node_modules");
      },
    });
    const [manifestBytes, readme] = await Promise.all([
      readFile(path.join(stagedPackage, "package.json"), "utf8"),
      readFile(path.join(stagedPackage, "README.md"), "utf8"),
    ]);
    const manifest = publishedManifest(JSON.parse(manifestBytes), readme);
    await writeFile(path.join(stagedPackage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(destination, { recursive: true });

    const { stdout } = await execFileAsync(
      process.execPath,
      [npmExecPath, "pack", "--ignore-scripts", "--pack-destination", destination, "--json", stagedPackage],
      { cwd: scratch, env, maxBuffer: 20 * 1024 * 1024 },
    );
    const receipts = JSON.parse(stdout);
    assert.equal(receipts.length, 1, "npm pack must produce exactly one tarball");
    return receipts[0];
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const destinationAt = argv.indexOf("--pack-destination");
  const packDestination = destinationAt === -1 ? undefined : argv[destinationAt + 1];
  if (!packDestination || argv.length !== 2) {
    throw new Error("usage: pack-npm-package.mjs --pack-destination <directory>");
  }
  return { packDestination };
}

async function main(argv = process.argv.slice(2)) {
  const receipt = await packNpmPackage(parseArgs(argv));
  process.stdout.write(`${JSON.stringify([receipt])}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
