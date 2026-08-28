// Build the single, self-contained, publishable CLI bundle.
//
// esbuild bundles src/index.ts together with its workspace source packages
// (@superbee/core, @superbee/server, @superbee/ui-server,
// @superbee/mcp-app) and every npm dependency into ONE ESM file with a
// `#!/usr/bin/env node` shebang. The published `superbee` package therefore has NO runtime
// dependencies and NO unresolved `workspace:*` links — `npx -y superbee …` runs with zero
// workspace resolution.
//
// The workspace deps are aliased to their SOURCE entry points so this build is self-contained:
// it does NOT require core/server to be pre-compiled to dist first (esbuild transpiles the .ts and
// resolves their NodeNext `.js`-extension imports to the sibling `.ts` files). That keeps
// the release build a single step.
//
// A createRequire shim is injected in the banner because a bundled CommonJS dependency (gray-matter)
// may call require() at runtime; ESM output has no ambient `require`, so we provide one.
//
// This explicitly flavored dev/npm build writes only dist/ plus gitignored generated inputs.
import { rm, chmod, cp, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isMainModule } from "../../scripts/is-main-module.mjs";
import { buildCliBundle, buildPublicationBundle } from "./scripts/build-bundle.mjs";
import { prepareCliBundleInputs } from "./scripts/prepare-bundle-inputs.mjs";
import { FUNCTIONAL_VERSION_FLOOR } from "./scripts/functional-version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(here, p);
const outfile = r("dist/superbee.mjs");
const publicationOutfile = r("dist/publication.mjs");
const execFileAsync = promisify(execFile);

async function copyDeclarationTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) await copyDeclarationTree(from, to);
    else if (entry.name.endsWith(".d.ts")) await cp(from, to);
  }
}

async function buildPublicationTypes() {
  const repoRoot = r("../..");
  const tsc = r("../../node_modules/typescript/bin/tsc");
  for (const workspace of ["core", "markdown-renderer", "view-runtime", "publication"]) {
    await execFileAsync(process.execPath, [tsc, "--project", r(`../${workspace}/tsconfig.json`)], {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
    });
  }
  await copyDeclarationTree(r("../publication/dist"), r("dist/publication"));
  await mkdir(r("dist/publication/schema"), { recursive: true });
  await cp(
    r("../publication/schema/publication-snapshot-v1.schema.json"),
    r("dist/publication/schema/publication-snapshot-v1.schema.json"),
  );
}

/**
 * The ONE dev/npm build entrypoint used by `npm run build`, `verify-npm-package.mjs`, and the
 * release workflow. It cleans dist, regenerates the
 * embedded inputs, bundles, and marks the bin executable — exactly once per call.
 *
 * `source` and `packageIdentity` are OPTIONAL injections for tests; when omitted, build-bundle
 * derives the source facts itself (the ordinary dev, verify, and release path).
 */
export async function buildCli(artifactChannel, { source, packageIdentity, updatePolicy } = {}) {
  if (artifactChannel !== "local-dev" && artifactChannel !== "npm-package") {
    throw new Error("usage: buildCli(local-dev|npm-package)");
  }
  // Clean dist so the packed tarball never carries stale files (files: ["dist"]).
  await rm(r("dist"), { recursive: true, force: true });
  // FIRST: generate every embedded input (the local UI assets and fixed MCP App shell) through the
  // same preparation helper used by release verification. The esbuild
  // bundle below imports those generated modules transitively, so none may be missing or stale.
  await prepareCliBundleInputs();
  await buildCliBundle(outfile, {
    artifactChannel,
    functionalVersionFloor: FUNCTIONAL_VERSION_FLOOR,
    updatePolicy: updatePolicy ?? { enabled: false },
    ...(source === undefined ? {} : { source }),
    ...(packageIdentity === undefined ? {} : { packageIdentity }),
  });
  await Promise.all([
    buildPublicationBundle(publicationOutfile),
    buildPublicationTypes(),
  ]);
  // The bin must be directly executable via its shebang (npm sets +x on install, but keep it correct
  // in the tarball and for direct `./dist/superbee.mjs` runs).
  await chmod(outfile, 0o755);
  return outfile;
}

async function main(argv = process.argv.slice(2)) {
  const built = await buildCli(argv[0]);
  console.log(`built ${built}`);
}

// Direct CLI invocation: `node build.mjs local-dev|npm-package`.
if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
