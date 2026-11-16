import { parseArgs } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadKinds, readDocVersioned } from "@superbee/core";
import { qualifyRecipeSet, parseRecipeQualificationConfig, type ExistingQualificationKind } from "@superbee/core/recipes";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError, classifyBundleError } from "../errors.js";
import { renderUsage } from "../output.js";
import { readAuthorFolder, AUTHOR_FILE_LIMITS } from "../integration-author/files.js";
import { readExternalFileBytesNoFollowWithin } from "../external-file.js";
import { parseUniqueJsonObject } from "../json-object.js";
import { assertPathOutsidePrivateState, assertSearchDirOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { openBundle } from "../bundle.js";
import { cliInvocation } from "../invocation.js";
import { commandToken } from "../command-text.js";

export const RECIPE_QUALIFY_USAGE = `superbee recipe qualify - prepare an explicitly bound set of ordinary recipes

Usage:
  superbee recipe qualify <config.json> [--dir <existing-bundle>] [--json]

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
Output is always one JSON document with schema recipe-qualification-output/v1, receipt and
files:[{path,bytes}]. The serialized document is bounded to 16 MiB. No folders or files are written.
Materialize the files separately under a root you choose; the receipt's install/evolve commands
run from that external materialization root. Edit canonical sources/configuration and regenerate;
do not maintain a second authored copy. --out is not supported.
Installation/evolution remain ordinary per-artifact operations, not atomic cookbook installation.

Options:
  --dir <bundle>        Explicit existing registry for retained Kind bindings (read only)
  --json                Accepted for consistency; successful output is always JSON
  -h, --help            Show this help
`;

/** One bounded transport envelope, emitted only after complete preparation and serialization. */
export const RECIPE_QUALIFICATION_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export async function recipeQualify(argv: string[], deps: { stdout?: (text: string) => void } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values, positionals } = parseLeafOrUsage(() => parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }), CLI_LEAVES.recipeQualify);
  if (values.help) { stdout(renderUsage(RECIPE_QUALIFY_USAGE)); return; }
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
  const receipt = { ...prepared.receipt,
    materialization: {
      required: true,
      instructions: "Materialize each files entry separately beneath a chosen external root, preserving its relative path and UTF-8 bytes. No output files or directories have been created.",
      commands_working_directory: "the external materialization root",
    },
    recipes: prepared.receipt.recipes.map(row => ({ ...row,
      commands: { install: `${cliInvocation()} recipe add ${commandToken(`./${row.key}`)}`,
        evolve: `${cliInvocation()} recipe evolve ${commandToken(`./${row.key}`)}` } })) };
  const files = prepared.recipes.flatMap(row => row.files.map(file => ({ path: `${row.key}/${file.path}`, bytes: file.bytes })));
  const output = JSON.stringify({ schema: "recipe-qualification-output/v1", receipt, files }) + "\n";
  if (Buffer.byteLength(output) > RECIPE_QUALIFICATION_OUTPUT_MAX_BYTES) {
    throw new CliError("USAGE", "Serialized qualification output exceeds 16 MiB; reduce the selected set");
  }
  stdout(output);
}
