import { parseArgs } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";
import { assertSafeConceptId, loadKinds, readDocVersioned } from "@superbee/core";
import { qualifyRecipeSet, parseRecipeQualificationConfig, type RecipeFile, type ExistingQualificationKind } from "@superbee/core/recipes";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError, classifyBundleError } from "../errors.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { readAuthorFolder, AUTHOR_FILE_LIMITS } from "../integration-author/files.js";
import { readExternalFileBytesNoFollowWithin } from "../external-file.js";
import { parseUniqueJsonObject } from "../json-object.js";
import { assertPathOutsidePrivateState, assertSearchDirOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { effectiveOutputPath } from "./egress.js";
import { openBundle } from "../bundle.js";
import { withCliFilesystemMutationLock } from "../filesystem-runtime.js";
import { cliInvocation } from "../invocation.js";
import { commandToken } from "../command-text.js";

export const RECIPE_QUALIFY_USAGE = `superbee recipe qualify - prepare an explicitly bound set of ordinary recipes

Usage:
  superbee recipe qualify <config.json> --out <new-folder> [--dir <existing-bundle>] [--json]

Configuration schema recipe-qualification/v1 selects 1 to 32 local recipes with unique keys,
relative source folders, and exactly namespace or preserve:true. Qualified names use explicit
canonical github.com/<positive-decimal-id>/<slug> or github.com/<owner>/<repository>/<slug>.
Namespace is a claim, not authentication. Recipe ownership is ns-SHA256(namespace).

Each external links/expects_inbound Kind requires a binding: {recipe:key,kind:source-governs}
or {existing:exact-Kind}. Existing bindings require --dir and a declared Kind in that bundle.
Own declarations cannot be overridden. Missing, ambiguous and unused bindings refuse the set.
Qualified entries may set paths:{source-governs:record-prefix}; otherwise authored record paths
remain unchanged. Friendly titles are labels; stored type/governs are always exact selectors.

Supports Conventions and declared static References only. Views, Connectors, undeclared assets,
unsupported HTML/reference links and relative non-concept assets refuse before output. Structural
inline Markdown links relocate; prose/code examples remain author-owned and untransformed.
Complete input/output: at most 512 files, 2 MiB/file, 8 MiB total; source nesting at most 12.
The output parent must exist; output must be NEW, outside bundles, private state and all sources.
Output contains one ordinary recipe folder per key and preparation-receipt.json. Regenerate into
a fresh directory; edit canonical sources/configuration, not the generated distribution copy.
Installation/evolution remain ordinary per-artifact operations, not atomic cookbook installation.

Options:
  --out <new-folder>    Required create-only complete-set output
  --dir <bundle>        Explicit existing registry for retained Kind bindings (read only)
  --json                Compact JSON instead of TOON
  -h, --help            Show this help
`;

async function absent(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => false, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return true;
    throw error;
  });
}
async function outputTarget(folder: string, sources: readonly string[]): Promise<string> {
  assertPathOutsidePrivateState(folder);
  if (!await absent(path.resolve(folder))) throw new CliError("ALREADY_EXISTS", "--out must name a new folder, including when the existing folder is empty");
  const target = await effectiveOutputPath(path.resolve(folder));
  assertPathOutsidePrivateState(target);
  const parent = await fs.realpath(path.dirname(target));
  for (const source of sources) {
    if (target === source || target.startsWith(source + path.sep)) throw new CliError("USAGE", "--out must be outside every source recipe");
  }
  // A generated package is never installation: refuse all ancestor index files conservatively.
  for (let ancestor = parent;; ancestor = path.dirname(ancestor)) {
    if (!await absent(path.join(ancestor, "index.md"))) throw new CliError("USAGE", "--out must be outside any bundle (an ancestor contains index.md)");
    if (path.dirname(ancestor) === ancestor) break;
  }
  return target;
}

/** Stage complete validated bytes, then exclusively create final paths under the writer lock. */
export async function writeQualifiedRecipeSet(folder: string, sources: readonly string[], files: readonly RecipeFile[]): Promise<string> {
  let total = 0; const seen = new Set<string>();
  for (const file of files) {
    assertSafeConceptId(file.path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file.path) || file.path.split("/").some(s => s.startsWith(".") || s.endsWith("."))) throw new CliError("USAGE", "Invalid prepared output path");
    if (seen.has(file.path.toLowerCase())) throw new CliError("USAGE", "Duplicate prepared output path");
    seen.add(file.path.toLowerCase());
    const size = Buffer.byteLength(file.bytes); total += size;
    if (size > AUTHOR_FILE_LIMITS.fileBytes || total > AUTHOR_FILE_LIMITS.totalBytes || files.length > AUTHOR_FILE_LIMITS.files) throw new CliError("USAGE", "Prepared set exceeds author-package bounds");
  }
  const target = await outputTarget(folder, sources);
  const stage = await fs.mkdtemp(path.join(path.dirname(target), ".recipe-qualification-"));
  const createdDirs: Array<{ file: string; dev: number; ino: number }> = [];
  const createdFiles: Array<{ file: string; dev: number; ino: number }> = [];
  async function remember(file: string, list: typeof createdDirs): Promise<void> {
    const stat = await fs.lstat(file); list.push({ file, dev: stat.dev, ino: stat.ino });
  }
  async function cleanup(): Promise<void> {
    for (const row of [...createdFiles].reverse()) {
      const stat = await fs.lstat(row.file).catch(() => null);
      if (stat?.dev === row.dev && stat.ino === row.ino) await fs.unlink(row.file).catch(() => {});
    }
    for (const row of [...createdDirs].reverse()) {
      const stat = await fs.lstat(row.file).catch(() => null);
      if (stat?.dev === row.dev && stat.ino === row.ino && stat.isDirectory()) await fs.rmdir(row.file).catch(() => {});
    }
  }
  let published = false;
  try {
    for (const file of files) {
      const destination = path.join(stage, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.bytes, { flag: "wx" });
    }
    await withCliFilesystemMutationLock(target, async () => {
      if (await outputTarget(folder, sources) !== target) throw new CliError("CONFLICT", "Output parent changed while staging");
      await fs.mkdir(target, { mode: 0o700 }); await remember(target, createdDirs);
      for (const file of files) {
        let dir = target;
        for (const segment of file.path.split("/").slice(0,-1)) {
          dir = path.join(dir, segment);
          if (!createdDirs.some(row => row.file === dir)) { await fs.mkdir(dir); await remember(dir, createdDirs); }
        }
        const destination = path.join(target, file.path);
        // Hard-link publication is create-only even if another writer races the leaf.
        await fs.link(path.join(stage, file.path), destination); await remember(destination, createdFiles);
      }
      await fs.chmod(target, 0o755); published = true;
    });
  } catch (error) {
    if (!published) await cleanup();
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw new CliError("CONFLICT", "Could not publish the prepared recipe set", {
      details: { output: target, published, residual_output: !await absent(target), temporary_residue: !await absent(stage) ? stage : null, reason: (error as NodeJS.ErrnoException).code ?? "write_failed" },
      help: "Inspect any reported residue; retry with a new output directory. Source files were not modified.",
    });
  }
  try { await fs.rm(stage, { recursive: true, force: true }); }
  catch { throw new CliError("CONFLICT", "Recipe set published, but temporary cleanup failed", { details: { output: target, published: true, temporary_residue: stage } }); }
  return target;
}

export async function recipeQualify(argv: string[], deps: { stdout?: (text: string) => void } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(() => parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { out: { type: "string" }, dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }), CLI_LEAVES.recipeQualify);
  if (values.help) { stdout(renderUsage(RECIPE_QUALIFY_USAGE)); return; }
  if (!values.out) throw new CliError("USAGE", "recipe qualify requires --out <new-folder>");
  assertPathOutsidePrivateState(values.out);
  if (values.dir !== undefined) assertSearchDirOutsidePrivateState(values.dir);
  const configPath = path.resolve(positionals[0]!);
  const acquired = await readExternalFileBytesNoFollowWithin(configPath, 256 * 1024);
  if (acquired.state !== "present") throw new CliError("USAGE", "Qualification configuration must be a regular UTF-8 JSON file within 256 KiB");
  let config;
  try { config = parseRecipeQualificationConfig(parseUniqueJsonObject(new TextDecoder("utf-8", { fatal: true }).decode(acquired.bytes))); }
  catch (error) { throw new CliError("USAGE", error instanceof Error ? error.message : "Invalid qualification configuration"); }
  const inputs = [];
  for (const entry of config.recipes) {
    const source = path.resolve(path.dirname(configPath), entry.source); assertPathOutsidePrivateState(source);
    const folder = await readAuthorFolder(source, { requiredFile: "recipe.md" });
    if (!folder.ok) throw new CliError("USAGE", `Cannot read selected recipe '${entry.key}'`, { details: { diagnostics: folder.diagnostics } });
    inputs.push({ entry, source: await fs.realpath(source), files: folder.files });
    const acquiredFiles = inputs.flatMap(input => input.files);
    if (acquiredFiles.length > AUTHOR_FILE_LIMITS.files || acquiredFiles.reduce((sum, file) => sum + Buffer.byteLength(file.bytes), 0) > AUTHOR_FILE_LIMITS.totalBytes) {
      throw new CliError("USAGE", "Complete selected set exceeds 512 files or 8 MiB total");
    }
  }
  const existing: ExistingQualificationKind[] = [];
  if (values.dir !== undefined) {
    const bundle = await openBundle(values.dir); const registry = await loadKinds(bundle);
    if (registry.warnings.length) throw new CliError("USAGE", "Explicit existing registry has warnings; resolve them before binding prerequisites", { details: { warnings: registry.warnings } });
    for (const kind of registry.kinds.values()) {
      const { doc, version } = await readDocVersioned(bundle, kind.id);
      if (doc.frontmatter.type !== "Convention" || doc.frontmatter.governs !== kind.governs) {
        throw new CliError("CONFLICT", "Existing Kind identity changed while observing prerequisites; retry preparation");
      }
      existing.push({ governs: kind.governs, id: kind.id, version });
    }
  }
  let prepared;
  try { prepared = qualifyRecipeSet(inputs, existing); }
  catch (error) { throw classifyBundleError(error); }
  const absoluteOutput = path.resolve(values.out);
  const receipt = { ...prepared.receipt, recipes: prepared.receipt.recipes.map(row => ({ ...row,
    commands: { install: `${cliInvocation()} recipe add ${commandToken(path.join(absoluteOutput, row.key))}`,
      evolve: `${cliInvocation()} recipe evolve ${commandToken(path.join(absoluteOutput, row.key))}` } })) };
  const files = prepared.recipes.flatMap(row => row.files.map(file => ({ path: `${row.key}/${file.path}`, bytes: file.bytes })));
  files.push({ path: "preparation-receipt.json", bytes: JSON.stringify(receipt, null, 2) + "\n" });
  const output = await writeQualifiedRecipeSet(values.out, inputs.map(i => i.source), files);
  stdout(render({ recipe_set: "qualified", output, receipt: path.join(output, "preparation-receipt.json"), recipes: receipt.recipes }, resolveMode(values)));
}
