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
// `prepublishOnly` a single step.
//
// A createRequire shim is injected in the banner because a bundled CommonJS dependency (gray-matter)
// may call require() at runtime; ESM output has no ambient `require`, so we provide one.
//
// This explicitly flavored dev/npm build writes only dist/ plus gitignored generated inputs.
import { rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildCliBundle } from "./scripts/build-bundle.mjs";
import { prepareCliBundleInputs } from "./scripts/prepare-bundle-inputs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const r = (p) => resolve(here, p);
const outfile = r("dist/superbee.mjs");

/**
 * The ONE dev/npm build entrypoint used by `npm run build`, `verify-npm-package.mjs`'s
 * scratch-candidate mode, AND the release-candidate command. It cleans dist, regenerates the
 * embedded inputs, bundles, and marks the bin executable — exactly once per call.
 *
 * `source` is an OPTIONAL injection: the release-candidate builder passes the exact protected
 * tag/checkout SHA (dirty:false) so the npm-package identity is baked from the tag, not from
 * whatever `currentSourceFacts()` observes in a CI checkout. When omitted, build-bundle derives
 * the facts itself (the ordinary dev/verify path).
 */
export async function buildCli(artifactChannel, { source, packageIdentity } = {}) {
  if (artifactChannel !== "local-dev" && artifactChannel !== "npm-package") {
    throw new Error("usage: buildCli(local-dev|npm-package)");
  }
  // Clean dist so the packed tarball never carries stale files (files: ["dist"]).
  await rm(r("dist"), { recursive: true, force: true });
  // FIRST: generate every embedded input (the local UI assets and fixed MCP App shell) through the
  // same preparation helper used by release verification. The esbuild
  // bundle below imports those generated modules transitively, so none may be missing or stale.
  await prepareCliBundleInputs();
  await buildCliBundle(outfile, { artifactChannel, ...(source === undefined ? {} : { source }), ...(packageIdentity === undefined ? {} : { packageIdentity }) });
  // The bin must be directly executable via its shebang (npm sets +x on install, but keep it correct
  // in the tarball and for direct `./dist/superbee.mjs` runs).
  await chmod(outfile, 0o755);
  return outfile;
}

// Direct CLI invocation: `node build.mjs local-dev|npm-package`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildCli(process.argv[2]);
  console.log(`built ${built}`);
}
