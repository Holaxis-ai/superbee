import { workspaceAliases } from "../../cli/scripts/bundle-options.mjs";
import { currentSourceFacts } from "../../cli/scripts/source-facts.mjs";
// Shared esbuild config for the self-contained npm CLI bundle. build.mjs selects the local-dev or
// npm-package flavor and writes packages/superbee/dist.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isStrictSemver } from "../../../scripts/strict-semver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// packages/superbee/scripts -> packages/superbee
const pkgRoot = resolve(here, "..");
const r = (p) => resolve(pkgRoot, p);

// The package version is one part of the immutable build identity baked into every bundle. Runtime
// code never promotes an adjacent package.json to version authority; it reads one only as a drift
// diagnostic.
const manifest = JSON.parse(readFileSync(r("package.json"), "utf8"));
const packageName = manifest.name;
const version = manifest.version;
if (
  typeof packageName !== "string" ||
  !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(packageName) ||
  packageName.length > 214 ||
  typeof version !== "string" ||
  version.length === 0
) {
  throw new Error("packages/superbee/package.json must contain a valid npm package name and non-empty version");
}
export const BUILD_ARTIFACT_CHANNELS = ["npm-package", "local-dev"];

export { currentSourceFacts };

/**
 * Bundle src/index.ts (+ the workspace source packages + every npm dep) into ONE self-contained
 * ESM file at `outfile`. Does not chmod the result; build.mjs owns executable permissions.
 */
function packageIdentity(options) {
  const identity = options?.packageIdentity ?? { name: packageName, version };
  if (
    typeof identity.name !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(identity.name) ||
    identity.name.length > 214 ||
    typeof identity.version !== "string" ||
    identity.version.length === 0
  ) {
    throw new Error("buildCliBundle packageIdentity must contain a valid npm package name and non-empty version");
  }
  return identity;
}

export async function buildCliBundle(outfile, options) {
  const artifactChannel = options?.artifactChannel;
  if (!BUILD_ARTIFACT_CHANNELS.includes(artifactChannel)) {
    throw new Error(
      `buildCliBundle requires artifactChannel: ${BUILD_ARTIFACT_CHANNELS.join(" | ")}`,
    );
  }
  const source = options?.source ?? currentSourceFacts();
  const functionalVersionFloor = options?.functionalVersionFloor;
  if (!isStrictSemver(functionalVersionFloor)) {
    throw new Error("buildCliBundle requires a strict SemVer functionalVersionFloor");
  }
  const updatePolicy = options?.updatePolicy;
  if (!updatePolicy || typeof updatePolicy !== "object" || typeof updatePolicy.enabled !== "boolean") {
    throw new Error("buildCliBundle requires an explicit updatePolicy.enabled boolean");
  }
  if (
    !(source?.commit === null || (typeof source?.commit === "string" && /^[a-f0-9]{40}$/.test(source.commit))) ||
    !(source?.dirty === null || typeof source?.dirty === "boolean")
  ) {
    throw new Error("buildCliBundle source must contain commit:40-hex|null and dirty:boolean|null");
  }
  if (artifactChannel === "npm-package" && (source.commit === null || source.dirty !== false)) {
    throw new Error(
      "npm-package release builds require an exact clean Git source " +
        `(40-hex commit and dirty:false); observed commit=${source.commit ?? "null"}, ` +
        `dirty=${String(source.dirty)}. Use local-dev for ordinary verification, or commit/stash/remove ` +
        "changes before release publication.",
    );
  }
  const pkg = packageIdentity(options);
  const identity = {
    schema: "superbee.build-identity.v1",
    package: { name: pkg.name, version: pkg.version },
    source,
    artifact: { channel: artifactChannel },
    compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
  };
  return build({
    metafile: options?.metafile ?? false,
    // Pin esbuild's working directory — it otherwise defaults to `process.cwd()` and embeds
    // paths relative to it in the CJS-interop module comments/keys (e.g. `node_modules/foo/…`
    // vs `../../node_modules/foo/…`), making the OUTPUT BYTES depend on the CALLER's cwd. Every
    // existing call site happened to run with cwd == this package (`npm run build -w superbee`,
    // `-w superbee` script invocations), so this went unnoticed until a
    // caller running from the repo root hit a false "changed"
    // diff on an otherwise-identical rebuild.
    absWorkingDir: pkgRoot,
    entryPoints: [r("src/index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // One compile-time authority read by build-identity.ts. The artifact hash is deliberately NOT
    // embedded (that would be recursive); runtime hashes the actual executing bytes lazily.
    define: {
      __SUPERBEE_BUILD_IDENTITY__: JSON.stringify(identity),
      __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__: JSON.stringify(functionalVersionFloor),
      __SUPERBEE_UPDATE_POLICY__: JSON.stringify(updatePolicy),
    },
    // Resolve the workspace deps to their TypeScript source so no dist pre-build is needed.
    alias: { ...workspaceAliases, "@superbee/cli": r("../cli/src/index.ts") },
    // NOTE: esbuild hoists the entry file's own `#!/usr/bin/env node` shebang (src/index.ts) to
    // the top of the output, so the banner must NOT repeat it (two shebangs = a syntax error).
    banner: {
      js: [
        // gray-matter (bundled, CJS) can call require() at runtime; ESM has none, so supply one.
        "import { createRequire as ___createRequire } from 'node:module';",
        "const require = ___createRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "info",
  });
}

/** Bundle the stable `superbee/publication` subpath with zero runtime dependencies. */
export async function buildPublicationBundle(outfile, surface = "full") {
  if (surface !== "full" && surface !== "bridge") throw new Error("unknown publication bundle surface");
  await build({
    absWorkingDir: pkgRoot,
    entryPoints: [r(surface === "bridge" ? "../publication/src/bridge-entry.ts" : "../publication/src/index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    alias: {
      "@superbee/core/page": r("../core/src/page.ts"),
      "@superbee/core/view-admission": r("../core/src/view-admission.ts"),
      "@superbee/core/links": r("../core/src/links.ts"),
      "@superbee/core/meaningful-change-time": r("../core/src/meaningful-change-time.ts"),
      "@superbee/core/mutation-attribution": r("../core/src/mutation-attribution.ts"),
      "@superbee/core/publication-filesystem": r("../core/src/publication-filesystem.ts"),
      "@superbee/core": r("../core/src/index.ts"),
      "@superbee/markdown-renderer/static": r("../markdown-renderer/src/static.tsx"),
      "@superbee/markdown-renderer": r("../markdown-renderer/src/index.tsx"),
      "@superbee/view-runtime": r("../view-runtime/src/index.ts"),
      "@superbee/view-runtime/bridge": r("../view-runtime/src/bridge.ts"),
    },
    banner: {
      js: [
        "import { createRequire as ___createRequire } from 'node:module';",
        surface === "full"
          ? "const require = ___createRequire(import.meta.url);"
          : "const require = ___createRequire('file:///superbee-publication-bridge.mjs');",
      ].join("\n"),
    },
    logLevel: "info",
  });
}

/** Bundle the stable `superbee/bundle-descriptor` subpath with zero runtime dependencies. */
export async function buildBundleDescriptorBundle(outfile) {
  await build({
    absWorkingDir: pkgRoot,
    entryPoints: [r("../bundle-descriptor/src/index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "info",
  });
}
