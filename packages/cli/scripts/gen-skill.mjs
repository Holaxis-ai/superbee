// Generate the eager SKILL.md from src/skill-render.ts and sync its focused `references/` folder
// from the inventory in src/distribution-resources.ts. The npm package and the repository-root
// Devin discovery copy are projections of the same source and resource manifest.
//
// AXI §7 "single source of truth": exact command syntax stays in the live CLI's help rather than a
// copied Skill manual. The npm package is the only executable distribution authority.
//
//   node scripts/gen-skill.mjs           → (re)write both generated skill targets
//   node scripts/gen-skill.mjs --check   → exit 1 if either target is stale
//
// src/skill-render.ts (which transitively pulls in reference.ts + src/distribution-resources.ts) is pure
// data + pure projections (no runtime imports), so we bundle it in-memory with esbuild and import
// the result as a data: URL — no temp files, no pre-build.
import { build } from "esbuild";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, sep, join } from "node:path";
import { isMainModule } from "../../../scripts/is-main-module.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillRenderTs = resolve(here, "../src/skill-render.ts");
// packages/cli/scripts -> repo root
const repoRoot = resolve(here, "../../..");

const packageSkillRoot = resolve(here, "..");
const devinSkillRoot = resolve(repoRoot, ".cognition/skills/superbee");
const devinSourceReceipt = `${JSON.stringify(
  {
    schema: "superbee.generated-agent-skill.v1",
    package: "superbee",
    source: "packages/cli/src/skill-render.ts",
    resource_manifest: "packages/cli/src/distribution-resources.ts",
    generated_by: "packages/cli/scripts/gen-skill.mjs",
    installed_for: "devin",
    discovery_path: ".cognition/skills/superbee",
  },
  null,
  2,
)}\n`;

const targets = [
  {
    label: "npm package skill",
    root: packageSkillRoot,
    skillPath: resolve(packageSkillRoot, "SKILL.md"),
    referencesDir: resolve(packageSkillRoot, "references"),
    receipt: null,
    generatedOnly: false,
  },
  {
    label: "Devin repository skill",
    root: devinSkillRoot,
    skillPath: resolve(devinSkillRoot, "SKILL.md"),
    referencesDir: resolve(devinSkillRoot, "references"),
    receipt: {
      path: resolve(devinSkillRoot, ".source.json"),
      content: devinSourceReceipt,
    },
    generatedOnly: true,
  },
];

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
async function syncReferences(resources, referencesDir) {
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
async function checkReferences(resources, referencesDir) {
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

async function checkTarget(target, content, resources) {
  const problems = [];
  const current = await readFile(target.skillPath, "utf8").catch(() => "");
  if (current !== content) problems.push(`${target.skillPath} is stale or missing`);

  problems.push(...(await checkReferences(resources, target.referencesDir)));

  if (target.receipt) {
    const currentReceipt = await readFile(target.receipt.path, "utf8").catch(() => "");
    if (currentReceipt !== target.receipt.content) {
      problems.push(`${target.receipt.path} is stale or missing`);
    }
  }

  if (target.generatedOnly) {
    const wanted = new Set([
      "SKILL.md",
      ...(target.receipt ? [relative(target.root, target.receipt.path).split(sep).join("/")] : []),
      ...resources.map(({ dest }) => `references/${dest}`),
    ]);
    for (const file of await listFilesRecursive(target.root)) {
      const rel = relative(target.root, file).split(sep).join("/");
      if (!wanted.has(rel)) problems.push(`${file} is not a generated skill file (stray file)`);
    }
  }

  return problems;
}

async function syncTarget(target, content, resources) {
  await mkdir(target.root, { recursive: true });
  await writeFile(target.skillPath, content);
  await syncReferences(resources, target.referencesDir);
  if (target.receipt) await writeFile(target.receipt.path, target.receipt.content);

  if (target.generatedOnly) {
    const wanted = new Set([
      "SKILL.md",
      ...(target.receipt ? [relative(target.root, target.receipt.path).split(sep).join("/")] : []),
      ...resources.map(({ dest }) => `references/${dest}`),
    ]);
    for (const file of await listFilesRecursive(target.root)) {
      const rel = relative(target.root, file).split(sep).join("/");
      if (!wanted.has(rel)) await rm(file);
    }
  }
}

// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    throw new Error("usage: node scripts/gen-skill.mjs [--check]");
  }
  return { checkOnly: argv[0] === "--check" };
}

export async function main(argv = process.argv.slice(2)) {
  const { checkOnly } = parseArgs(argv);
  const { renderNpm, NPM_RESOURCES } = await loadSkillRender();
  const content = renderNpm();
  const resources = NPM_RESOURCES;

  if (checkOnly) {
    const problems = [];
    for (const target of targets) {
      for (const problem of await checkTarget(target, content, resources)) {
        problems.push(`${target.label}: ${problem}`);
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      console.error("run `node scripts/gen-skill.mjs` to regenerate.");
      process.exit(1);
    }
    for (const target of targets) console.log(`${target.skillPath} is up to date.`);
  } else {
    for (const target of targets) {
      await syncTarget(target, content, resources);
      console.log(`wrote ${target.skillPath}`);
      console.log(`synced ${target.referencesDir}`);
      if (target.receipt) console.log(`wrote ${target.receipt.path}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(error instanceof Error && message === "usage: node scripts/gen-skill.mjs [--check]" ? 2 : 1);
  });
}
