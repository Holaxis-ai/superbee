// The ONE release-candidate command. After the source gates pass, this cleans the candidate
// output, builds the npm-package bundle ONCE with the injected protected tag SHA (dirty:false),
// runs `npm pack` ONCE, and emits an immutable candidate manifest (tarball SHA-256, npm pack
// identity, tag/source/build identity/compatibility contracts, and the generated-asset agreement).
// It then proves the RETAINED tarball through the no-build/no-pack verifier — so the bytes recorded
// in the manifest are exactly the bytes that were verified and will be staged. Nothing after this
// command rebuilds or repacks: the staged-release workflow, the operator, and the finalizer all
// consume this retained artifact by its immutable identifiers.
//
// Usage: node scripts/release-candidate.mjs --tag v<version> --commit <40-hex> [--out <dir>] [--json]
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildCli } from "../packages/cli/build.mjs";
import { currentSourceFacts } from "../packages/cli/scripts/build-bundle.mjs";
import { sanitizedNpmEnvironment, verifyRetainedTarball, fileSha256 } from "./verify-npm-package.mjs";
import {
  DEFAULT_RELEASE_TARGETS_PATH,
  RELEASE_CANDIDATE_SCHEMA,
  assertAllowedTuple,
  loadReleaseTargets,
  resolveReleaseTarget,
} from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const cliRoot = path.join(repoRoot, "packages", "cli");
const OUTPUT_OWNER = ".aslite-release-candidate-owned-v1";
const OUTPUT_OWNER_CONTENT = "agentstate-lite release candidate output v1\n";

export function parseCandidateArgs(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const get = (flag) => {
    const at = rest.indexOf(flag);
    if (at === -1) return undefined;
    const value = rest[at + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    return value;
  };
  const tag = get("--tag");
  const commit = get("--commit");
  const out = get("--out") ?? "release-candidate";
  const target = get("--target");
  const manifest = get("--manifest") ?? DEFAULT_RELEASE_TARGETS_PATH;
  if (!tag || !commit || !target) {
    throw new Error("usage: release-candidate.mjs --target <target> --tag v<version> --commit <40-hex> [--manifest <release/targets.json>] [--out <dir>] [--json]");
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`--tag must be a v-prefixed SemVer tag, got ${tag}`);
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`--commit must be an exact 40-hex SHA, got ${commit}`);
  }
  return { tag, commit, target, manifest, out, json };
}

async function listReferenceShas() {
  const root = path.join(cliRoot, "references");
  const entries = [];
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) entries.push(child.split(path.sep).join("/"));
    }
  }
  await walk("");
  entries.sort();
  const shas = {};
  for (const rel of entries) shas[rel] = await fileSha256(path.join(root, ...rel.split("/")));
  return shas;
}

/** Refuse broad, symlinked, or foreign non-empty output directories before recursive cleanup. */
export async function prepareCandidateOutputDir(requested) {
  const outDir = path.resolve(requested);
  const root = path.parse(outDir).root;
  if (outDir === root || outDir === repoRoot || repoRoot.startsWith(`${outDir}${path.sep}`)) {
    throw new Error(`unsafe --out target: ${outDir}`);
  }

  let entries = [];
  try {
    const info = await lstat(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`--out must be a real directory, not a symlink or file: ${outDir}`);
    }
    entries = await readdir(outDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (entries.length > 0) {
    if (!entries.includes(OUTPUT_OWNER)) {
      throw new Error(`refusing to clean non-empty --out directory not owned by release-candidate: ${outDir}`);
    }
    const marker = await readFile(path.join(outDir, OUTPUT_OWNER), "utf8");
    if (marker !== OUTPUT_OWNER_CONTENT) {
      throw new Error(`refusing to clean --out directory with an invalid ownership marker: ${outDir}`);
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, OUTPUT_OWNER), OUTPUT_OWNER_CONTENT);
  return outDir;
}

export function assertCandidateSource(commit, observed = currentSourceFacts()) {
  if (observed.commit !== commit) {
    throw new Error(`--commit ${commit} does not match checked-out HEAD ${observed.commit ?? "unknown"}`);
  }
  if (observed.dirty !== false) {
    throw new Error(`release candidate requires a clean checkout; observed dirty=${String(observed.dirty)}`);
  }
  return observed;
}

async function preparePackRoot({ target, version, outDir }) {
  const packRoot = path.join(outDir, "pack-root");
  await rm(packRoot, { recursive: true, force: true });
  await mkdir(path.join(packRoot, "dist"), { recursive: true });
  await cp(path.join(cliRoot, "references"), path.join(packRoot, "references"), { recursive: true });
  for (const file of ["LICENSE", "README.md", "SKILL.md"]) {
    await cp(path.join(cliRoot, file), path.join(packRoot, file));
  }
  await cp(path.join(cliRoot, ...target.artifact.split("/")), path.join(packRoot, ...target.artifact.split("/")));
  const baseManifest = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
  const releaseManifest = {
    name: target.package.name,
    version,
    type: baseManifest.type,
    description: baseManifest.description,
    keywords: baseManifest.keywords,
    license: baseManifest.license,
    homepage: baseManifest.homepage,
    repository: baseManifest.repository,
    bugs: baseManifest.bugs,
    bin: target.bins,
    files: ["dist", "SKILL.md", "references"],
    publishConfig: { access: "public" },
    engines: baseManifest.engines,
  };
  await writeFile(path.join(packRoot, "package.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  return packRoot;
}

/**
 * Build once, pack once, emit the immutable manifest, verify the RETAINED tarball. Returns the
 * candidate manifest object. `verify` defaults true; the workflow passes it, tests can skip the
 * heavy install proof and assert the build/pack-once shape directly.
 */
export async function createReleaseCandidate({
  tag,
  commit,
  target: targetId,
  manifest: targetManifestPath = DEFAULT_RELEASE_TARGETS_PATH,
  out,
  verify = true,
  sourceFacts,
}) {
  const version = tag.slice(1);
  const targetManifest = await loadReleaseTargets(targetManifestPath);
  const target = await resolveReleaseTarget(targetId, { manifestPath: targetManifestPath });
  assertAllowedTuple(targetManifest, { target: target.id, packageName: target.package.name, version, tag });
  // Never trust a caller-supplied SHA or invented clean-tree claim. Production callers always use
  // the observed Git facts; sourceFacts is injectable only so the build-once unit test can remain
  // hermetic while its own test checkout contains uncommitted test edits.
  assertCandidateSource(commit, sourceFacts ?? currentSourceFacts());

  const requestedOut = path.isAbsolute(out) ? out : path.join(repoRoot, out);
  // Clean only an empty or explicitly-owned candidate directory, so --out can never recursively
  // erase an arbitrary caller-selected path.
  const outDir = await prepareCandidateOutputDir(requestedOut);

  // BUILD ONCE — npm-package channel, exact injected tag SHA, clean tree required.
  await buildCli("npm-package", { source: { commit, dirty: false }, packageIdentity: { name: target.package.name, version } });

  // PACK ONCE — the single npm pack of this transaction. --ignore-scripts so no lifecycle hook can
  // trigger a second build/pack.
  const env = sanitizedNpmEnvironment(process.env, path.join(outDir, ".empty-npmrc"), path.join(outDir, ".npm-cache"));
  const npmCli = env.npm_execpath?.trim();
  if (!npmCli) throw new Error("npm_execpath is required; run this through `npm run release:candidate`");
  await writeFile(path.join(outDir, ".empty-npmrc"), "");
  const packRoot = await preparePackRoot({ target, version, outDir });
  const packed = await execFileAsync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", outDir, packRoot], {
    cwd: repoRoot,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const receipts = JSON.parse(packed.stdout);
  if (receipts.length !== 1) throw new Error(`npm pack must produce exactly one tarball, got ${receipts.length}`);
  const receipt = receipts[0];
  const tarballPath = path.join(outDir, receipt.filename);
  const tarballSha = await fileSha256(tarballPath);

  const candidate = {
    schema: RELEASE_CANDIDATE_SCHEMA,
    target: target.id,
    tag,
    version,
    package: { name: target.package.name },
    source: { commit, dirty: false },
    build_identity: {
      schema: "superbee.build-identity.v1",
      package: { name: target.package.name, version },
      source: { commit, dirty: false },
      artifact: { channel: "npm-package", sha256: await fileSha256(path.join(cliRoot, "dist", "superbee.mjs")) },
      compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
    },
    compatibility_contracts: { skill: 1, hook: 1, mcp: 1 },
    tarball: {
      path: path.relative(repoRoot, tarballPath),
      filename: receipt.filename,
      version: receipt.version,
      sha256: tarballSha,
      shasum: receipt.shasum,
      integrity: receipt.integrity,
      size: receipt.size,
      unpacked_size: receipt.unpackedSize,
    },
    agreement: {
      release_targets_sha256: await fileSha256(targetManifestPath),
      skill_md_sha256: await fileSha256(path.join(cliRoot, "SKILL.md")),
      references_sha256: await listReferenceShas(),
    },
  };
  const manifestPath = path.join(outDir, "candidate.json");
  await writeFile(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);

  if (verify) {
    // Prove the RETAINED bytes — no build, no pack. A swapped/rebuilt tarball fails closed here.
    await verifyRetainedTarball({ tarball: tarballPath, manifest: manifestPath });
  }
  return { candidate, tarballPath, manifestPath, outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const args = parseCandidateArgs(process.argv.slice(2));
    const result = await createReleaseCandidate(args);
    if (args.json) {
      console.log(JSON.stringify(result.candidate));
    } else {
      const t = result.candidate.tarball;
      console.log(
        `release candidate ${result.candidate.tag}: ${t.filename} ${t.sha256} (${t.size} bytes) retained at ` +
          `${path.relative(repoRoot, result.tarballPath)}; manifest ${path.relative(repoRoot, result.manifestPath)}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
