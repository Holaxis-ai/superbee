// Generate the eager SKILL.md from src/skill-render.ts and sync the package's focused
// `references/` folder from the inventory in src/distribution-resources.ts: a byte-for-byte copy of
// each source file, with any
// stray file under references/ NOT named in the manifest deleted. Idempotent/convergent, same
// discipline as the SKILL.md write itself.
//
// AXI §7 "single source of truth": exact command syntax stays in the live CLI's help rather than a
// copied Skill manual. The npm package is the only executable distribution authority.
//
//   node scripts/gen-skill.mjs           → (re)write SKILL.md, references/, and superbee.skill.zip
//   node scripts/gen-skill.mjs --check   → exit 1 if any generated Skill asset is stale
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

const skillPath = resolve(here, "../SKILL.md");
const referencesDir = resolve(here, "../references");
const archivePath = resolve(here, "../superbee.skill.zip");
const ARCHIVE_ROOT = "superbee";

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
// Portable archive — a deterministic STORE-only ZIP whose root is the complete `superbee/` Skill
// directory. STORE avoids a runtime dependency and makes archive bytes a direct, inspectable
// projection of SKILL.md and the resource inventory. ZIP readers create nested directories from
// the entry names, but an explicit root entry keeps import UIs that inspect directory entries happy.
// ---------------------------------------------------------------------------------------------

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name, bytes, offset) {
  const nameBytes = Buffer.from(name, "utf8");
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(name.endsWith("/") ? 0x10 : 0, 38);
  central.writeUInt32LE(offset, 42);
  return { local: Buffer.concat([local, nameBytes, bytes]), central: Buffer.concat([central, nameBytes]) };
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const entry = zipEntry(name, bytes, offset);
    locals.push(entry.local);
    centrals.push(entry.central);
    offset += entry.local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

async function archiveBytes(content, resources) {
  const entries = [{ name: `${ARCHIVE_ROOT}/`, bytes: Buffer.alloc(0) }];
  entries.push({ name: `${ARCHIVE_ROOT}/SKILL.md`, bytes: Buffer.from(content) });
  for (const { src, dest } of [...resources].sort((a, b) => a.dest.localeCompare(b.dest))) {
    entries.push({ name: `${ARCHIVE_ROOT}/references/${dest}`, bytes: await readFile(resolve(repoRoot, src)) });
  }
  return createZip(entries);
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
  const expectedArchive = await archiveBytes(content, resources);

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
    const currentArchive = await readFile(archivePath).catch(() => null);
    if (currentArchive === null || !currentArchive.equals(expectedArchive)) {
      console.error(`${archivePath} is stale or missing — run \`node scripts/gen-skill.mjs\` to regenerate.`);
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
    await writeFile(archivePath, expectedArchive);
    console.log(`wrote ${archivePath}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(error instanceof Error && message === "usage: node scripts/gen-skill.mjs [--check]" ? 2 : 1);
  });
}
