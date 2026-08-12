// Generate a SKILL.md from the CLI's single source of truth (src/reference.ts COMMAND_GROUPS,
// rendered by src/skill-render.ts), and sync the package's `references/` folder from the inventory
// in src/distribution-resources.ts: a byte-for-byte copy of each source file, with any
// stray file under references/ NOT named in the manifest deleted. Idempotent/convergent, same
// discipline as the SKILL.md write itself.
//
// AXI §7 "single source of truth": the npm package's command reference is DERIVED from the same
// COMMAND_GROUPS the home view + `--help` render, so it cannot drift. The npm package is the only
// executable distribution authority.
//
//   node scripts/gen-skill.mjs           → (re)write packages/cli/SKILL.md + references/
//   node scripts/gen-skill.mjs --check   → exit 1 if SKILL.md or references/ is stale
//
// src/skill-render.ts (which transitively pulls in reference.ts + src/distribution-resources.ts) is pure
// data + pure projections (no runtime imports), so we bundle it in-memory with esbuild and import
// the result as a data: URL — no temp files, no pre-build.
import { build } from "esbuild";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, sep, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skillRenderTs = resolve(here, "../src/skill-render.ts");
// packages/cli/scripts -> repo root
const repoRoot = resolve(here, "../../..");

const skillPath = resolve(here, "../SKILL.md");
const referencesDir = resolve(here, "../references");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("usage: node scripts/gen-skill.mjs [--check]");
  process.exit(2);
}
const checkOnly = args[0] === "--check";

async function loadSkillRender() {
  const out = await build({
    entryPoints: [skillRenderTs],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const code = out.outputFiles[0].text;
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

// ---------------------------------------------------------------------------------------------
// references/ sync — read via the same bundle as the renderer, so a --check run and a real regen
// can never disagree about the manifest.
// ---------------------------------------------------------------------------------------------

/** All files under `dir`, recursively, as absolute paths (empty array if `dir` doesn't exist). */
async function listFilesRecursive(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

/** Copy every manifest entry byte-for-byte into `referencesDir`, then delete any file under it not named in the manifest. */
async function syncReferences(resources) {
  for (const { src, dest } of resources) {
    const bytes = await readFile(resolve(repoRoot, src));
    const destPath = resolve(referencesDir, dest);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
  }
  const wanted = new Set(resources.map((r) => r.dest));
  for (const file of await listFilesRecursive(referencesDir)) {
    const rel = relative(referencesDir, file).split(sep).join("/");
    if (!wanted.has(rel)) await rm(file);
  }
}

/** --check's references-side: every manifest file must byte-match, and nothing extra may exist. */
async function checkReferences(resources) {
  const problems = [];
  for (const { src, dest } of resources) {
    const srcPath = resolve(repoRoot, src);
    const destPath = resolve(referencesDir, dest);
    let wantBytes;
    try {
      wantBytes = await readFile(srcPath);
    } catch (err) {
      problems.push(`manifest source is missing: ${srcPath} (${err.message})`);
      continue;
    }
    const haveBytes = await readFile(destPath).catch(() => null);
    if (haveBytes === null || !wantBytes.equals(haveBytes)) {
      problems.push(`${destPath} is stale or missing`);
    }
  }
  const wanted = new Set(resources.map((r) => r.dest));
  for (const file of await listFilesRecursive(referencesDir)) {
    const rel = relative(referencesDir, file).split(sep).join("/");
    if (!wanted.has(rel)) problems.push(`${file} is not in the manifest (stray file)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------

const { renderNpm, NPM_RESOURCES } = await loadSkillRender();
const content = renderNpm();
const resources = NPM_RESOURCES;

if (checkOnly) {
  let ok = true;
  let current = "";
  try {
    current = await readFile(skillPath, "utf8");
  } catch {
    /* missing → stale */
  }
  if (current !== content) {
    console.error(`${skillPath} is stale — run \`node scripts/gen-skill.mjs\` to regenerate.`);
    ok = false;
  }
  for (const problem of await checkReferences(resources)) {
    console.error(problem);
    ok = false;
  }
  if (!ok) {
    console.error("run `node scripts/gen-skill.mjs` to regenerate.");
    process.exit(1);
  }
  console.log(`${skillPath} is up to date.`);
} else {
  await writeFile(skillPath, content);
  console.log(`wrote ${skillPath}`);
  await syncReferences(resources);
  console.log(`synced ${referencesDir}`);
}
