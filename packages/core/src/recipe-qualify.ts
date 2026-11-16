/** Finite, explicit cookbook preparation; output is ordinary recipe format. No I/O or solver. */
import { parseMarkdown, stringifyDoc } from "./frontmatter.js";
import { parseRecipeFiles, type RecipeFile, type LoadedRecipe } from "./recipes.js";
import { assertSafeConceptId, assertSafeFilePath } from "./paths.js";
import { InvalidInputError } from "./errors.js";
import type { Frontmatter } from "./types.js";
import { sha256Hex } from "./versioning.js";
import { buildKindRegistry } from "./kinds.js";
import { materializeRecipeForEdition, assertRecipeStorable } from "./recipe-lifecycle/install.js";
import { recipeSourceDigest } from "./recipe-lifecycle/stamp.js";
import { recipeFilesDigest } from "./recipe-sources.js";
import { extractMarkdownLinkSpans, rewriteMarkdownLinks, resolveConceptId, relativeHref, isExternalHref, maskMarkdownCode, normalizeSegments } from "./links.js";

export type RecipeKindBinding = { recipe: string; kind: string } | { existing: string };
export interface RecipeQualificationEntry {
  key: string;
  source: string;
  namespace?: string;
  preserve?: true;
  bindings?: Record<string, RecipeKindBinding>;
  paths?: Record<string, string>;
}
export interface RecipeQualificationConfig { schema: "recipe-qualification/v1"; recipes: RecipeQualificationEntry[] }
export interface RecipeQualificationInput { entry: RecipeQualificationEntry; files: readonly RecipeFile[]; /** Canonical source coordinate, for structural links between selected folders. */ source: string }
export interface ExistingQualificationKind { governs: string; id: string; version: string }
export interface PreparedRecipe { key: string; files: RecipeFile[]; recipe: LoadedRecipe }
export interface RecipeQualificationResult { recipes: PreparedRecipe[]; receipt: {
  schema: "recipe-qualification-receipt/v1";
  recipes: Array<{ key: string; source: string; namespace?: string; preserve: boolean; id: string; version: string;
    source_digest: string; source_files_digest: string; output_digest: string; output_files_digest: string;
    kinds: Array<{ source: string; selector: string; title: string; path?: string }>;
    definitions: Array<{ source: string; destination: string }>;
    bindings: Array<{ source: string; target: string; binding: RecipeKindBinding }> }>;
  prerequisites: ExistingQualificationKind[];
  shared_record_paths: Array<{ path: string; selectors: string[] }>;
  untransformed: string[];
} }

function fail(message: string): never { throw new InvalidInputError(`Cannot qualify recipe set: ${message}`); }
const byteLength = (value: string): number => new TextEncoder().encode(value).length;
const LOCAL_NAME = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${at} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at}: unknown key '${key}'`);
}
function text(value: unknown, at: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(`${at} must be a non-empty exact string`);
  return value as string;
}
function recordPath(value: string): string {
  const trimmed = value.endsWith("/") ? value.slice(0,-1) : value;
  assertSafeConceptId(trimmed);
  if (!SOURCE_PATH.test(trimmed) || byteLength(trimmed) > 512) fail(`unsupported record prefix '${value}'`);
  return value;
}
/** Strict configuration grammar, shared by CLI and programmatic preparation. */
export function parseRecipeQualificationConfig(value: unknown): RecipeQualificationConfig {
  const config = object(value, "configuration"); keys(config, ["schema", "recipes"], "configuration");
  if (config.schema !== "recipe-qualification/v1") fail("expected schema recipe-qualification/v1");
  if (!Array.isArray(config.recipes) || config.recipes.length < 1 || config.recipes.length > 32) fail("recipes must contain 1 to 32 explicit selections");
  const seen = new Set<string>();
  const recipes = config.recipes.map((raw, i): RecipeQualificationEntry => {
    const row = object(raw, `recipes[${i}]`); keys(row, ["key", "source", "namespace", "preserve", "bindings", "paths"], `recipes[${i}]`);
    const key = text(row.key, "key");
    if (!SAFE_KEY.test(key) || key.length > 64 || seen.has(key)) fail(`invalid or duplicate selection key '${key}'`);
    seen.add(key);
    const source = text(row.source, `${key}.source`);
    if (source.startsWith("/") || /^[A-Za-z]:/.test(source) || /[\\\x00-\x1f]/.test(source)) fail(`${key}.source must be a local relative directory`);
    if ((row.namespace !== undefined) === (row.preserve !== undefined) || (row.preserve !== undefined && row.preserve !== true)) fail(`${key} requires exactly namespace or preserve:true`);
    const entry: RecipeQualificationEntry = { key, source, ...(row.namespace !== undefined ? { namespace: text(row.namespace, `${key}.namespace`) } : { preserve: true }) };
    if (entry.namespace) qualificationRecipeId(entry.namespace);
    if (row.paths !== undefined) {
      if (entry.preserve) fail(`${key}: paths cannot override preserved placement`);
      entry.paths = Object.fromEntries(Object.entries(object(row.paths, `${key}.paths`)).map(([kind, path]) => [kind, recordPath(text(path, `${key}.paths.${kind}`))]));
    }
    if (row.bindings !== undefined) {
      entry.bindings = Object.fromEntries(Object.entries(object(row.bindings, `${key}.bindings`)).map(([target, rawBinding]) => {
        text(target, `${key} binding token`);
        if (target.includes(":")) fail(`${key}: cross-bundle relationship targets are not supported by preparation`);
        const binding = object(rawBinding, `${key}.bindings.${target}`);
        if (Object.hasOwn(binding, "existing")) {
          keys(binding, ["existing"], "existing binding");
          const existing = text(binding.existing, "existing Kind");
          if (existing.includes(":")) fail("cross-bundle existing bindings are not supported");
          return [target, { existing }];
        }
        keys(binding, ["recipe", "kind"], "recipe binding");
        return [target, { recipe: text(binding.recipe, "bound recipe"), kind: text(binding.kind, "bound source Kind") }];
      }));
    }
    return entry;
  });
  return { schema: "recipe-qualification/v1", recipes };
}
/** Hash exact canonical spelling, not a release or schema. Namespace claims are not authentication. */
export function qualificationRecipeId(namespace: string): string {
  const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
  const numeric = new RegExp(`^github\\.com/[1-9][0-9]*/${slug}$`);
  const readable = new RegExp(`^github\\.com/${slug}/${slug}/${slug}$`);
  if ((!numeric.test(namespace) && !readable.test(namespace)) || byteLength(namespace) > 220) fail("namespace must be canonical lowercase github.com/<positive-decimal-id>/<slug> or github.com/<owner>/<repository>/<slug>, at most 220 UTF-8 bytes");
  return `ns-${sha256Hex(namespace)}`;
}
function checkedRecipe(files: RecipeFile[], source: string): LoadedRecipe {
  const loaded = parseRecipeFiles(files, source, { okfVersion: "0.2" });
  if (!loaded.ok) fail(loaded.error.message);
  if (loaded.recipe.warnings.length) fail(loaded.recipe.warnings.map(w => w.message).join("; "));
  assertRecipeStorable(loaded.recipe, "0.2");
  const materialized = materializeRecipeForEdition(loaded.recipe, "0.2");
  const registry = buildKindRegistry(materialized.docs, [], { okfVersion: "0.2" });
  if (registry.warnings.length) fail(registry.warnings.map(w => w.message).join("; "));
  return loaded.recipe;
}
function fileDigest(files: readonly RecipeFile[]): string { return recipeFilesDigest(files.map(f => ({ path: f.path, bytes: new TextEncoder().encode(f.bytes) }))); }
function coordinate(root: string, id: string): string { return normalizeSegments([...root.split("/"), ...id.split("/")]).join("/"); }

/** Allocate every identity first, then bind relationships. A selected cycle requires no solver. */
export function qualifyRecipeSet(inputs: readonly RecipeQualificationInput[], existing: readonly ExistingQualificationKind[] = []): RecipeQualificationResult {
  const config = parseRecipeQualificationConfig({ schema: "recipe-qualification/v1", recipes: inputs.map(i => i.entry) });
  const outputKinds = new Set<string>(); const owners = new Set<string>(); const paths = new Set<string>();
  const coordinates = new Map<string, string>(); const existingByKind = new Map<string, ExistingQualificationKind>();
  for (const kind of existing) {
    if (existingByKind.has(kind.governs)) fail(`ambiguous existing Kind '${kind.governs}'`);
    existingByKind.set(kind.governs, kind);
  }
  let total = 0; let count = 0;
  const allocated = inputs.map((input, index) => {
    const entry = config.recipes[index]!; const seen = new Set<string>();
    for (const file of input.files) {
      assertSafeFilePath(file.path);
      if (!SOURCE_PATH.test(file.path) || byteLength(file.path) > 1024 || file.path.split("/").some(s => s.endsWith("."))) fail(`unsupported source path '${file.path}'`);
      if (seen.has(file.path.toLowerCase())) fail(`duplicate portable source path '${file.path}'`);
      seen.add(file.path.toLowerCase()); total += byteLength(file.bytes); count++;
      if (byteLength(file.bytes) > 2 * 1024 * 1024 || total > 8 * 1024 * 1024 || count > 512) fail("complete set exceeds 512 files, 2 MiB/file or 8 MiB total");
    }
    const manifestFile = input.files.find(f => f.path === "recipe.md");
    if (!manifestFile) fail(`${entry.key}: missing recipe.md`);
    const manifest = parseMarkdown(manifestFile.bytes);
    for (const field of ["pages", "connectors", "composes", "seeds", "requires"]) if (manifest.frontmatter[field] !== undefined) fail(`${entry.key}: '${field}' unsupported; prepare only Conventions and declared static References`);
    const strictFiles = input.files.map(f => f.path === "recipe.md" ? { ...f, bytes: stringifyDoc({ ...manifest.frontmatter, content_policy: "definitions-only" }, manifest.body) } : { ...f });
    const source = checkedRecipe(strictFiles, input.source);
    const owner = entry.namespace ? qualificationRecipeId(entry.namespace) : source.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner) || owners.has(owner)) fail(`invalid or duplicate output recipe id '${owner}'`);
    owners.add(owner);
    const names = new Map<string, string>(); const destinations = new Map<string, string>();
    for (const doc of source.docs) {
      const name = doc.frontmatter.governs as string;
      if (entry.namespace && !LOCAL_NAME.test(name)) fail(`${entry.key}: source governs '${name}' must be ASCII alphanumeric words separated by single spaces, underscores or hyphens`);
      if (name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) fail(`noncanonical source governs in ${entry.key}`);
      const full = entry.namespace ? `${entry.namespace}/${name}` : name;
      if (full.includes(":") || byteLength(full) > 256) fail(`unsupported output Kind '${full}' (maximum 256 UTF-8 bytes, no colon)`);
      if (outputKinds.has(full)) fail(`duplicate output governs '${full}'`);
      outputKinds.add(full); names.set(name, full);
    }
    for (const kind of Object.keys(entry.paths ?? {})) if (!names.has(kind)) fail(`${entry.key}: paths names undeclared Kind '${kind}'`);
    for (const doc of [...source.docs, ...source.references.map(r => r.doc)]) {
      const slash = doc.id.indexOf("/");
      const destination = entry.namespace ? `${doc.id.slice(0, slash)}/${owner}/${doc.id.slice(slash + 1)}` : doc.id;
      if (paths.has(destination.toLowerCase())) fail(`duplicate output definition path '${destination}'`);
      paths.add(destination.toLowerCase()); destinations.set(doc.id, destination);
      const location = coordinate(input.source, doc.id);
      if (coordinates.has(location)) fail(`ambiguous selected source coordinate '${location}'`);
      coordinates.set(location, destination);
    }
    return { input, entry, manifest, source, owner, names, destinations };
  });
  const byKey = new Map(allocated.map(a => [a.entry.key, a]));
  const prerequisites = new Map<string, ExistingQualificationKind>();
  const receipt: RecipeQualificationResult["receipt"] = { schema: "recipe-qualification-receipt/v1", recipes: [], prerequisites: [], shared_record_paths: [], untransformed: ["Prose, code examples and query strings remain author-owned and are not transformed."] };
  const recordPaths = new Map<string, string[]>();
  const recipes = allocated.map(a => {
    const { input, entry, source, manifest, owner, names, destinations } = a;
    const used = new Set<string>(); const bindings: RecipeQualificationResult["receipt"]["recipes"][number]["bindings"] = [];
    function target(kind: string): string {
      if (names.has(kind)) {
        if (Object.hasOwn(entry.bindings ?? {}, kind)) fail(`${entry.key}: binding cannot override own Kind '${kind}'`);
        return names.get(kind)!;
      }
      if (kind.includes(":")) fail(`${entry.key}: cross-bundle target '${kind}' is unsupported`);
      const binding = Object.hasOwn(entry.bindings ?? {}, kind) ? entry.bindings![kind] : undefined;
      if (!binding) fail(`${entry.key}: missing explicit binding for external Kind '${kind}'`);
      let resolved: string;
      if ("existing" in binding) {
        const observed = existingByKind.get(binding.existing);
        if (!observed) fail(`${entry.key}: existing Kind '${binding.existing}' is not declared in the explicit existing bundle`);
        if (outputKinds.has(binding.existing)) fail(`existing binding '${binding.existing}' collides with a selected definition; use a recipe binding`);
        prerequisites.set(binding.existing, observed); resolved = binding.existing;
      } else {
        const selected = byKey.get(binding.recipe);
        if (!selected || !selected.names.has(binding.kind)) fail(`${entry.key}: binding '${kind}' names absent recipe/Kind '${binding.recipe}/${binding.kind}'`);
        resolved = selected.names.get(binding.kind)!;
      }
      if (!used.has(kind)) bindings.push({ source: kind, target: resolved, binding });
      used.add(kind); return resolved;
    }
    function bodyAt(body: string, from: string, to: string): string {
      const spans = extractMarkdownLinkSpans(body, { skipCode: true }); let remaining = maskMarkdownCode(body);
      for (const span of [...spans].reverse()) remaining = remaining.slice(0, span.start) + " ".repeat(span.end - span.start) + remaining.slice(span.end);
      if (/<\/?[A-Za-z][^>]*>|\[[^\]\n]*\]\s*(?:\(|\[)|^ {0,3}\[[^\]\n]+\]:/m.test(remaining)) fail(`${entry.key}/${from}: unsupported HTML or Markdown link syntax; use plain inline Markdown links or code-fenced examples`);
      return rewriteMarkdownLinks(body, spans, span => {
        if (isExternalHref(span.href)) return undefined;
        const local = resolveConceptId(from, span.href);
        if (local === null) fail(`${entry.key}/${from}: cannot relocate non-concept link '${span.href}'`);
        let destination = destinations.get(local);
        if (!span.href.startsWith("/")) {
          const fromLocation = coordinate(input.source, from);
          const structural = resolveConceptId(fromLocation, span.href);
          const cross = structural ? coordinates.get(structural) : undefined;
          if (cross) destination = cross;
          const relativePath = span.href.split(/[?#]/)[0]!;
          const localSegments = normalizeSegments([...from.split("/").slice(0,-1), ...relativePath.split("/")]);
          if (localSegments[0] === ".." && !cross) fail(`${entry.key}/${from}: structural link '${span.href}' leaves its recipe without an unambiguous selected destination`);
        }
        const queryStart = span.href.indexOf("?");
        const fragmentStart = span.href.indexOf("#");
        const suffixStart = queryStart < 0 ? fragmentStart
          : fragmentStart < 0 ? queryStart : Math.min(queryStart, fragmentStart);
        return relativeHref(to, destination ?? local) + (suffixStart < 0 ? "" : span.href.slice(suffixStart));
      });
    }
    const output: RecipeFile[] = [];
    const fm: Frontmatter = { ...manifest.frontmatter, id: owner, content_policy: "definitions-only" };
    if (source.references.length) fm.references = source.references.map(r => `${destinations.get(r.doc.id)}.md`);
    output.push({ path: "recipe.md", bytes: stringifyDoc(fm, bodyAt(manifest.body, "recipe", "recipe")) });
    const kinds: RecipeQualificationResult["receipt"]["recipes"][number]["kinds"] = [];
    for (const doc of [...source.docs, ...source.references.map(r => r.doc)]) {
      const id = destinations.get(doc.id)!; const frontmatter = { ...doc.frontmatter };
      if (frontmatter.type === "Convention") {
        const name = frontmatter.governs as string;
        frontmatter.governs = names.get(name)!;
        if (entry.namespace) frontmatter.title ??= name;
        if (Object.hasOwn(entry.paths ?? {}, name)) frontmatter.path = entry.paths![name];
        for (const field of ["links", "expects_inbound"]) {
          const map = frontmatter[field] as Record<string, string> | undefined;
          if (map) frontmatter[field] = Object.fromEntries(Object.entries(map).map(([label, kind]) => [label, target(kind)]));
        }
        const prefix = frontmatter.path as string | undefined;
        kinds.push({ source: name, selector: names.get(name)!, title: (frontmatter.title as string | undefined) ?? name, ...(prefix ? { path: prefix } : {}) });
        if (prefix) { const canonical = prefix.replace(/\/$/, ""); recordPaths.set(canonical, [...(recordPaths.get(canonical) ?? []), names.get(name)!]); }
      }
      output.push({ path: `${id}.md`, bytes: stringifyDoc(frontmatter, bodyAt(doc.body, doc.id, id)) });
    }
    for (const token of Object.keys(entry.bindings ?? {})) if (!used.has(token)) fail(`${entry.key}: unused binding '${token}'`);
    output.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const recipe = checkedRecipe(output, entry.key);
    receipt.recipes.push({ key: entry.key, source: entry.source, ...(entry.namespace ? { namespace: entry.namespace } : {}), preserve: entry.preserve === true,
      id: owner, version: recipe.version, source_digest: recipeSourceDigest(source), source_files_digest: fileDigest(input.files), output_digest: recipeSourceDigest(recipe), output_files_digest: fileDigest(output),
      kinds, definitions: [...destinations].map(([source,destination]) => ({ source, destination })), bindings });
    return { key: entry.key, files: output, recipe };
  });
  receipt.prerequisites = [...prerequisites.values()];
  receipt.shared_record_paths = [...recordPaths].filter(([,selectors]) => selectors.length > 1).map(([path,selectors]) => ({ path, selectors }));
  // Expansion can grow both identifiers and structural links. Bound generated bytes as well
  // as acquired bytes, before any caller receives a successful complete-set artifact.
  const outputFiles = recipes.flatMap(recipe => recipe.files);
  if (outputFiles.length > 512 || outputFiles.some(file => byteLength(file.bytes) > 2 * 1024 * 1024)
      || outputFiles.reduce((sum, file) => sum + byteLength(file.bytes), 0) > 8 * 1024 * 1024) {
    fail("prepared output exceeds 512 files, 2 MiB/file or 8 MiB total");
  }
  return { recipes, receipt };
}
