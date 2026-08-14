// Shared esbuild config for the self-contained npm CLI bundle. build.mjs selects the local-dev or
// npm-package flavor and writes packages/cli/dist.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isStrictSemver } from "../../../scripts/strict-semver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// packages/cli/scripts -> packages/cli
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
  throw new Error("packages/cli/package.json must contain a valid npm package name and non-empty version");
}
const repoRoot = resolve(pkgRoot, "../..");
export const BUILD_ARTIFACT_CHANNELS = ["npm-package", "local-dev"];

function gitFact(args, fallback) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

/** Build-time source evidence. Unknown is represented explicitly, never invented. */
export function currentSourceFacts() {
  const commit = gitFact(["rev-parse", "HEAD"], "");
  const status = gitFact(["status", "--porcelain=v1", "--untracked-files=all"], null);
  return {
    commit: commit || null,
    dirty: status === null ? null : status.length > 0,
  };
}

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
  await build({
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
    alias: {
      // List browser-safe core subpaths before the package root so esbuild does not append the
      // subpath to `index.ts` (which would resolve as the impossible `index.ts/page`).
      "@superbee/core/page": r("../core/src/page.ts"),
      "@superbee/core/links": r("../core/src/links.ts"),
      "@superbee/core/meaningful-change-time": r("../core/src/meaningful-change-time.ts"),
      "@superbee/core": r("../core/src/index.ts"),
      // The git tier lives in its own workspace package (board-git A1); alias to source so the
      // npm artifact stays ONE self-contained file with no dist pre-build.
      "@superbee/board-git": r("../board-git/src/index.ts"),
      // server/src/index.ts is guard-free re-exports (createRouter + serve) — its only deps are
      // core + node:http, so aliasing straight to it keeps the esbuild bundle ONE self-contained file.
      "@superbee/server": r("../server/src/index.ts"),
      // The experimental conversational View adapter is private workspace source. It is bundled
      // into the npm CLI exactly like the other internal packages, leaving no runtime workspace
      // dependency for users to install or resolve.
      "@superbee/mcp-app": r("../mcp-app/src/index.ts"),
      // Shared human-surface primitives are private workspace source too. Alias them explicitly
      // so a clean npm build never depends on sibling dist/ directories existing.
      "@superbee/markdown-renderer/static": r("../markdown-renderer/src/static.tsx"),
      "@superbee/markdown-renderer": r("../markdown-renderer/src/index.tsx"),
      "@superbee/view-runtime": r("../view-runtime/src/index.ts"),
      // The loopback UI runtime is a private workspace package; source-alias it so the npm CLI
      // remains one self-contained artifact with no workspace dependency at install time.
      "@superbee/ui-server": r("../ui-server/src/index.ts"),
    },
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
