// Records which workspace engines one CLI artifact embeds and from which commit. The bundle embeds
// workspace SOURCE, so a declared version does not establish equality with a published package of
// that version; the release workflow establishes that for the recorded commit, not this record.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
export const EMBEDDED_ENGINE_SCHEMA = "superbee.cli-embedded-engine.v2";
// Workspaces released under the synchronized `libraries/v<version>` tag identity.
const releaseTagged = new Set(["@superbee/core", "@superbee/server"]);

const readManifest = dir => JSON.parse(readFileSync(resolve(repoRoot, "packages", dir, "package.json"), "utf8"));

/** Repo-relative paths of everything the artifact embeds: the runtime bundle's metafile inputs
 * (relative to packages/cli) plus the absolute paths the asset generation stages read. */
export function embeddedInputs(metafile, assetInputs = []) {
  const paths = [...Object.keys(metafile.inputs).map(input => resolve(cliRoot, input)), ...assetInputs];
  return [...new Set(paths.map(path => relative(repoRoot, path).split(sep).join("/")))];
}

/** Rows come from the bundler's own inputs, so a newly embedded workspace cannot be omitted. */
export function embeddedEngineRecord({ inputs, source, manifestOf = readManifest }) {
  const dirs = new Set();
  for (const path of inputs) {
    const parts = path.split("/");
    if (parts[0] === "packages" && parts.length > 2 && !parts.includes("node_modules") && parts[1] !== "cli") dirs.add(parts[1]);
  }
  const packages = [...dirs].sort().map(dir => {
    const { name, version } = manifestOf(dir);
    if (typeof name !== "string" || !name.startsWith("@superbee/") || typeof version !== "string") {
      throw new Error(`packages/${dir} contributes bundle inputs but is not a versioned @superbee workspace`);
    }
    return { name, version, release_tag: releaseTagged.has(name) ? `libraries/v${version}` : null };
  });
  return { schema: EMBEDDED_ENGINE_SCHEMA, packages, source };
}
