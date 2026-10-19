/**
 * The `@superbee/core/search` boundary: the subpath imports only itself, core's pure SHA-256, canonical paths, typed errors, heads digest and
 * erased types, and names no Node global, so a Worker, a browser page and the CLI load the same
 * bytes. The browser-bundle test runs the built subpath in a sandbox with only TextEncoder and
 * TextDecoder; this one fences the source so a new import is refused before anything is built.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_ROOT = path.resolve(here, "../src/search");
const ALLOWED_OUTSIDE = new Map([
  ["../sha256.js", "value"],
  ["../paths.js", "value"],
  ["../errors.js", "value"],
  ["../heads-digest.js", "value"],
  ["../types.js", "type-only"],
]);
const NODE_GLOBALS = new Set(["Buffer", "process", "require", "createRequire", "global", "__dirname", "__filename"]);

function violationsIn(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const flag = (node: ts.Node, message: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`search/${path.basename(file)}:${line + 1}: ${message}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
      if (specifier.startsWith("./") && !specifier.slice(2).includes("/")) {
        // A sibling inside the subpath.
      } else if (ALLOWED_OUTSIDE.get(specifier) === "value" || (ALLOWED_OUTSIDE.get(specifier) === "type-only" && typeOnly)) {
        // Explicit pure core dependencies, or core's types erased at build.
      } else {
        flag(node, `reaches outside the search subpath: "${specifier}"`);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) flag(node, "import-equals declaration");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) flag(node, "dynamic import()");
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) flag(node, `names the Node global "${node.text}"`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test("the search subpath imports only its approved pure core dependencies and names no Node global", async () => {
  const files = (await readdir(SEARCH_ROOT)).filter((name) => name.endsWith(".ts")).sort();
  assert.ok(files.includes("index.ts") && files.includes("memory-source.ts"), files.join(","));
  const violations: string[] = [];
  for (const name of files) {
    const file = path.join(SEARCH_ROOT, name);
    violations.push(...violationsIn(file, await readFile(file, "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("the fence refuses an outside import, a value import of types, a node: import and a Node global", () => {
  const planted = [
    'import { openBundle } from "../bundle.js";',
    'import { InvalidInputError } from "../types.js";',
    'import { createHash } from "node:crypto";',
    'import { x } from "./nested/deeper.js";',
    "const bytes = Buffer.from('x');",
    "const env = process.env;",
  ].join("\n");
  assert.deepEqual(violationsIn(path.join(SEARCH_ROOT, "planted.ts"), planted), [
    'search/planted.ts:1: reaches outside the search subpath: "../bundle.js"',
    'search/planted.ts:2: reaches outside the search subpath: "../types.js"',
    'search/planted.ts:3: reaches outside the search subpath: "node:crypto"',
    'search/planted.ts:4: reaches outside the search subpath: "./nested/deeper.js"',
    'search/planted.ts:5: names the Node global "Buffer"',
    'search/planted.ts:6: names the Node global "process"',
  ]);
  assert.deepEqual(violationsIn(path.join(SEARCH_ROOT, "planted.ts"), 'import type { OkfDocument } from "../types.js";'), []);
});

test("the fence admits only the named pure dependencies, not other pure core modules", () => {
  const file = path.join(SEARCH_ROOT, "planted.ts");
  for (const module of ["paths", "errors", "heads-digest"])
    assert.deepEqual(violationsIn(file, `import { value } from "../${module}.js";`), []);
  assert.deepEqual(violationsIn(file, 'import { matchesFilter } from "../query-filter.js";'), [
    'search/planted.ts:1: reaches outside the search subpath: "../query-filter.js"',
  ]);
});
