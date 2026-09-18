// Records which workspace engines one CLI artifact embeds. The bundle embeds workspace SOURCE, so a
// declared version does not establish equality with a published package of that version: each row
// carries a measured comparison against its release tag, or null where none can be made.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
export const EMBEDDED_ENGINE_SCHEMA = "superbee.cli-embedded-engine.v1";
// Workspaces released under the synchronized `libraries/v<version>` tag identity.
const releaseTagged = new Set(["@superbee/core", "@superbee/server"]);

/** Exit status and stdout of a git query; null when git cannot run. */
function runGit(args, input) {
  try {
    return { status: 0, stdout: execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] }) };
  } catch (error) {
    return typeof error.status === "number" ? { status: error.status, stdout: "" } : null;
  }
}
const readManifest = dir => JSON.parse(readFileSync(resolve(repoRoot, "packages", dir, "package.json"), "utf8"));

/** Repo-relative paths of everything the artifact embeds: the runtime bundle's metafile inputs
 * (relative to packages/cli) plus the absolute paths the asset generation stages read. */
export function embeddedInputs(metafile, assetInputs = []) {
  const paths = [...Object.keys(metafile.inputs).map(input => resolve(cliRoot, input)), ...assetInputs];
  return [...new Set(paths.map(path => relative(repoRoot, path).split(sep).join("/")))];
}

/** Rows come from the bundler's own inputs, so a newly embedded workspace cannot be omitted. */
export function embeddedEngineRecord({ inputs, source, git = runGit, manifestOf = readManifest }) {
  const inputsByDir = new Map();
  for (const path of inputs) {
    const parts = path.split("/");
    if (parts[0] === "packages" && parts.length > 2 && !parts.includes("node_modules") && parts[1] !== "cli") inputsByDir.set(parts[1], [...(inputsByDir.get(parts[1]) ?? []), path]);
  }
  // The tag diff reads committed trees, while the bundler read working-tree bytes. Index flags,
  // uncommitted edits and untracked generated modules all hide from `git status`, so the embedded
  // bytes themselves are compared blob by blob with HEAD before any tag comparison is reported.
  // The manifest names the row's version and tag, so it is compared with its inputs.
  const embeddedBytesCommitted = dir => {
    const paths = [...new Set([...inputsByDir.get(dir), `packages/${dir}/package.json`])];
    const head = git(["ls-tree", "-r", "-z", "HEAD", "--", `packages/${dir}`]);
    const worktree = git(["hash-object", "--stdin-paths"], paths.join("\n") + "\n");
    if (head?.status !== 0 || worktree?.status !== 0) return false;
    const committed = new Map(head.stdout.split("\0").filter(Boolean).map(line => { const [meta, path] = line.split("\t"); return [path, meta.split(" ")[2]]; }));
    const hashes = worktree.stdout.split("\n").filter(Boolean);
    return hashes.length === paths.length && paths.every((path, index) => committed.get(path) === hashes[index]);
  };
  const packages = [...inputsByDir.keys()].sort().map(dir => {
    const { name, version } = manifestOf(dir);
    if (typeof name !== "string" || !name.startsWith("@superbee/") || typeof version !== "string") {
      throw new Error(`packages/${dir} contributes bundle inputs but is not a versioned @superbee workspace`);
    }
    const release_tag = releaseTagged.has(name) ? `libraries/v${version}` : null;
    let source_identical_to_release_tag = null;
    if (release_tag !== null && git(["rev-parse", "--verify", "--quiet", `refs/tags/${release_tag}^{commit}`])?.status === 0 && embeddedBytesCommitted(dir)) {
      const diff = git(["diff", "--quiet", `refs/tags/${release_tag}`, "HEAD", "--", `packages/${dir}`]);
      if (diff?.status === 0 || diff?.status === 1) source_identical_to_release_tag = diff.status === 0;
    }
    return { name, version, release_tag, source_identical_to_release_tag };
  });
  return { schema: EMBEDDED_ENGINE_SCHEMA, packages, source };
}
