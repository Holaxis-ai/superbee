/**
 * Isomorphic-boundary gate: every core subpath the BROWSER runtime-imports must bundle for the
 * browser with no `node:*` builtin. The browser consumers are the SPA and shared Markdown
 * renderer; this test derives their `@superbee/core` imports directly from source so adding a
 * runtime import automatically adds a proof row.
 *
 * This DECLARES that isomorphic surface once and gates it, rather than discovering a Node-only
 * import the hard way at build time (the `links.ts` → `node:path` break, designs/doc-reader HIGH-1,
 * cost a real detour). Each subpath is bundled with esbuild `platform: "browser"`; any node builtin
 * sneaking in fails with "Could not resolve" (red-on-regression). Requires a prior root build — the
 * sibling-dist convention other core tests document.
 *
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const BROWSER_CONSUMER_ROOTS = [
  path.join(REPOSITORY_ROOT, "packages", "ui", "src"),
  path.join(REPOSITORY_ROOT, "packages", "markdown-renderer", "src"),
];
const CORE_PACKAGE = "@superbee/core";

interface CoreManifest {
  exports?: Record<string, { default?: string }>;
}

function hasRuntimeBinding(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly || clause.name !== undefined) return !clause.isTypeOnly;
  if (clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function runtimeCoreSpecifiersIn(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === CORE_PACKAGE || node.moduleSpecifier.text.startsWith(`${CORE_PACKAGE}/`)) &&
      hasRuntimeBinding(node)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers];
}

async function walkSources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSources(fullPath)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function browserRuntimeCoreSpecifiers(): Promise<string[]> {
  const specifiers = new Set<string>();
  for (const root of BROWSER_CONSUMER_ROOTS) {
    for (const file of await walkSources(root)) {
      for (const specifier of runtimeCoreSpecifiersIn(file, await readFile(file, "utf8"))) specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}

function distEntryFor(specifier: string, manifest: CoreManifest): string {
  const exportKey = specifier === CORE_PACKAGE ? "." : `./${specifier.slice(`${CORE_PACKAGE}/`.length)}`;
  const target = manifest.exports?.[exportKey]?.default;
  assert.ok(target, `${specifier} is a browser runtime import but not a declared core export`);
  return path.resolve(PACKAGE_ROOT, target);
}

test("browser core-import discovery ignores type-only imports and includes runtime subpaths", () => {
  const fixture = [
    'import type { Frontmatter } from "@superbee/core";',
    'import { type KindConvention } from "@superbee/core/kinds";',
    'import { resolveConceptId } from "@superbee/core/links";',
    'import * as page from "@superbee/core/page";',
  ].join("\n");
  assert.deepEqual(runtimeCoreSpecifiersIn("fixture.tsx", fixture).sort(), [
    "@superbee/core/links",
    "@superbee/core/page",
  ]);
});

const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as CoreManifest;
const browserSpecifiers = await browserRuntimeCoreSpecifiers();
assert.ok(browserSpecifiers.length > 0, "expected browser runtime imports of @superbee/core");

for (const specifier of browserSpecifiers) {
  test(`${specifier} bundles for the browser with no node builtins`, async () => {
    const result = await build({
      entryPoints: [distEntryFor(specifier, manifest)],
      bundle: true,
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0, `${specifier}: ${JSON.stringify(result.errors, null, 2)}`);
    assert.ok(result.outputFiles[0]!.text.length > 0, `${specifier}: expected browser bundle output`);
  });
}
