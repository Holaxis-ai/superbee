import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, "..");
const SOURCE_ROOT = path.resolve(PACKAGE_ROOT, "src");
const RUNTIME_DEPENDENCIES = ["gray-matter", "js-yaml"] as const;

function specifierViolation(file: string, specifier: string): string | null {
  if (isBuiltin(specifier) || RUNTIME_DEPENDENCIES.some((name) => name === specifier)) return null;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved === SOURCE_ROOT || resolved.startsWith(`${SOURCE_ROOT}${path.sep}`)) return null;
    return `relative import escapes core/src: "${specifier}"`;
  }

  return `disallowed specifier "${specifier}"`;
}

function violationsIn(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const flag = (node: ts.Node, message: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const relativeFile = path.relative(PACKAGE_ROOT, file).split("\\").join("/");
    violations.push(`${relativeFile}:${line + 1} — ${message}`);
  };

  const checkSpecifier = (node: ts.Node, specifier: ts.Expression): void => {
    if (!ts.isStringLiteralLike(specifier)) {
      flag(node, "non-literal module specifier");
      return;
    }
    const violation = specifierViolation(file, specifier.text);
    if (violation !== null) flag(node, violation);
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      checkSpecifier(node, node.moduleSpecifier);
    }

    if (ts.isImportEqualsDeclaration(node)) {
      flag(node, "import-equals declaration (a require channel)");
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier === undefined) flag(node, "dynamic import() without a specifier");
      else checkSpecifier(node, specifier);
    }

    if (ts.isIdentifier(node) && (node.text === "require" || node.text === "createRequire")) {
      flag(node, `reference to "${node.text}"`);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

async function walkSources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSources(fullPath)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

test("core production imports stay inside the bottom layer", async () => {
  const files = await walkSources(SOURCE_ROOT);
  assert.ok(files.length >= 20, `expected core source modules, found ${files.length}`);

  const violations: string[] = [];
  for (const file of files) {
    violations.push(...violationsIn(file, await readFile(file, "utf8")));
  }

  assert.deepEqual(violations, [], `core import-direction violations:\n${violations.join("\n")}`);
});

test("core manifest pins the production dependency contract", async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...RUNTIME_DEPENDENCIES]);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
});

test("core import-direction policy rejects hidden upward import channels", () => {
  const syntheticFile = path.join(SOURCE_ROOT, "synthetic.ts");
  const source = [
    'import type { Router } from "@superbee/server";',
    'export { something } from "../../server/src/index.js";',
    "const target = './types.js';",
    "void import(target);",
    'import fs = require("node:fs");',
    'const viaRequire = require("./types.js");',
    "void createRequire;",
    'import allowed from "gray-matter";',
    'export type { Bundle } from "./types.js";',
  ].join("\n");

  assert.deepEqual(violationsIn(syntheticFile, source), [
    'src/synthetic.ts:1 — disallowed specifier "@superbee/server"',
    'src/synthetic.ts:2 — relative import escapes core/src: "../../server/src/index.js"',
    "src/synthetic.ts:4 — non-literal module specifier",
    "src/synthetic.ts:5 — import-equals declaration (a require channel)",
    'src/synthetic.ts:6 — reference to "require"',
    'src/synthetic.ts:7 — reference to "createRequire"',
  ]);
});
