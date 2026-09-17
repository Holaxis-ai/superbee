// Records which workspace engines one CLI artifact embeds. The bundle embeds workspace SOURCE, so a
// declared version does not establish equality with a published package of that version: each row
// carries a measured comparison against its release tag, or null where none can be made.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentSourceFacts } from "./source-facts.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
export const EMBEDDED_ENGINE_SCHEMA = "superbee.cli-embedded-engine.v1";
// Workspaces released under the synchronized `libraries/v<version>` tag identity.
const releaseTagged = new Set(["@superbee/core", "@superbee/server"]);

/** Exit status and stdout of a git query; null when git cannot run. */
function runGit(args) {
  try {
    return { status: 0, stdout: execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
  } catch (error) {
    return typeof error.status === "number" ? { status: error.status, stdout: "" } : null;
  }
}
const readManifest = dir => JSON.parse(readFileSync(resolve(repoRoot, "packages", dir, "package.json"), "utf8"));

/** Facts about the tree the bundler is about to read. Call before the build writes any file. */
export function captureSourceState() {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedPaths = status?.status === 0
    ? status.stdout.split("\n").filter(Boolean).flatMap(line => line.slice(3).split(" -> ")).map(path => path.replace(/^"/, ""))
    : null;
  return { source: currentSourceFacts(), changedPaths };
}

/** Rows come from the bundler's own inputs, so a newly embedded workspace cannot be omitted. */
export function embeddedEngineRecord({ metafile, source, changedPaths, git = runGit, manifestOf = readManifest }) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = relative(repoRoot, resolve(cliRoot, input)).split(sep);
    if (parts[0] === "packages" && parts.length > 2 && !parts.includes("node_modules") && parts[1] !== "cli") dirs.add(parts[1]);
  }
  const packages = [...dirs].sort().map(dir => {
    const { name, version } = manifestOf(dir);
    if (typeof name !== "string" || !name.startsWith("@superbee/") || typeof version !== "string") {
      throw new Error(`packages/${dir} contributes bundle inputs but is not a versioned @superbee workspace`);
    }
    const release_tag = releaseTagged.has(name) ? `libraries/v${version}` : null;
    let source_identical_to_release_tag = null;
    // The comparison reads HEAD while the bundler read the working tree, so it is reported only
    // when this package had no uncommitted or untracked change.
    const clean = changedPaths !== null && !changedPaths.some(path => path.startsWith(`packages/${dir}/`));
    if (release_tag !== null && clean && git(["rev-parse", "--verify", "--quiet", `refs/tags/${release_tag}^{commit}`])?.status === 0) {
      const diff = git(["diff", "--quiet", `refs/tags/${release_tag}`, "HEAD", "--", `packages/${dir}`]);
      if (diff?.status === 0 || diff?.status === 1) source_identical_to_release_tag = diff.status === 0;
    }
    return { name, version, release_tag, source_identical_to_release_tag };
  });
  return { schema: EMBEDDED_ENGINE_SCHEMA, packages, source };
}
