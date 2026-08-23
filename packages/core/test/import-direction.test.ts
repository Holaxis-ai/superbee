import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { publicExportSpecifiers } from "../../../scripts/package-exports.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, "..");
const SOURCE_ROOT = path.resolve(PACKAGE_ROOT, "src");
const DIST_ROOT = path.resolve(PACKAGE_ROOT, "dist");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const FIRST_PARTY_SOURCE_ROOTS = [path.join(REPOSITORY_ROOT, "packages"), path.join(REPOSITORY_ROOT, "scripts")];
const RUNTIME_DEPENDENCIES = ["gray-matter", "js-yaml"] as const;
const CORE_PACKAGE = "@superbee/core";
const DECLARED_CORE_SPECIFIERS = new Set(
  publicExportSpecifiers(
    JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")),
    CORE_PACKAGE,
  ),
);

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
    violations.push(`${path.relative(PACKAGE_ROOT, file)}:${line + 1} — ${message}`);
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

function coreBoundaryBypass(file: string, specifier: string): string | null {
  if (specifier === CORE_PACKAGE || specifier.startsWith(`${CORE_PACKAGE}/`)) {
    return DECLARED_CORE_SPECIFIERS.has(specifier) ? null : specifier;
  }
  let physicalSpecifier = specifier;
  if (specifier.startsWith("file:")) {
    try {
      physicalSpecifier = fileURLToPath(specifier);
    } catch {
      return null;
    }
  }
  if (!physicalSpecifier.startsWith(".") && !path.isAbsolute(physicalSpecifier)) return null;
  const resolved = path.resolve(path.dirname(file), physicalSpecifier);
  if (
    resolved === SOURCE_ROOT ||
    resolved.startsWith(`${SOURCE_ROOT}${path.sep}`) ||
    resolved === DIST_ROOT ||
    resolved.startsWith(`${DIST_ROOT}${path.sep}`)
  ) {
    return specifier;
  }
  return null;
}

function coreSourceSpecifierInExpression(
  file: string,
  expression: ts.Expression,
  urls: ReadonlyMap<string, string>,
): string | null {
  if (ts.isStringLiteralLike(expression)) return coreBoundaryBypass(file, expression.text);
  if (ts.isIdentifier(expression)) return urls.get(expression.text) ?? null;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "href") {
    return coreSourceSpecifierInExpression(file, expression.expression, urls);
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toString"
  ) {
    return coreSourceSpecifierInExpression(file, expression.expression.expression, urls);
  }
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "URL" &&
    expression.arguments?.[0] !== undefined
  ) {
    return coreSourceSpecifierInExpression(file, expression.arguments[0], urls);
  }
  return null;
}

function sourceBypassViolationsIn(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];
  const urls = new Map<string, string>();
  const requireFactories = new Set<string>();
  const requireFactoryNamespaces = new Set<string>();
  const requireAliases = new Set<string>();
  const flag = (node: ts.Node, specifier: ts.Expression): void => {
    const coreSpecifier = coreSourceSpecifierInExpression(file, specifier, urls);
    if (coreSpecifier === null) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${line + 1} — core package-boundary bypass "${coreSpecifier}"`);
  };

  const isCreateRequireCall = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    (
      (ts.isIdentifier(expression.expression) && requireFactories.has(expression.expression.text)) ||
      (
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        requireFactoryNamespaces.has(expression.expression.expression.text) &&
        expression.expression.name.text === "createRequire"
      )
    );

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      flag(node, node.moduleSpecifier);
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:module" &&
      node.importClause?.namedBindings !== undefined
    ) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "createRequire") requireFactories.add(element.name.text);
        }
      } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
        requireFactoryNamespaces.add(node.importClause.namedBindings.name.text);
      }
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined) flag(node, expression);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const coreSpecifier = coreSourceSpecifierInExpression(file, node.initializer, urls);
      if (coreSpecifier !== null) urls.set(node.name.text, coreSpecifier);
      if (isCreateRequireCall(node.initializer)) requireAliases.add(node.name.text);
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        if (specifier !== undefined) flag(node, specifier);
      }
      if (ts.isIdentifier(node.expression) && (node.expression.text === "require" || requireAliases.has(node.expression.text))) {
        const specifier = node.arguments[0];
        if (specifier !== undefined) flag(node, specifier);
      }
      if (ts.isCallExpression(node.expression) && isCreateRequireCall(node.expression)) {
        const specifier = node.arguments[0];
        if (specifier !== undefined) flag(node, specifier);
      }
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
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") files.push(...(await walkSources(fullPath)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(fullPath);
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

test("first-party source imports cannot bypass the declared core package boundary", async () => {
  const violations: string[] = [];
  for (const root of FIRST_PARTY_SOURCE_ROOTS) {
    for (const file of await walkSources(root)) {
      if (file === PACKAGE_ROOT || file.startsWith(`${PACKAGE_ROOT}${path.sep}`)) continue;
      violations.push(...sourceBypassViolationsIn(file, await readFile(file, "utf8")));
    }
  }

  assert.deepEqual(violations, [], `first-party core source bypasses:\n${violations.join("\n")}`);
});

test("first-party source-bypass scanner rejects static core package-boundary bypasses", () => {
  const syntheticFile = path.join(REPOSITORY_ROOT, "packages", "cli", "test", "source-bypass.ts");
  const source = [
    'import { acquireFilesystemMutationLock } from "../../core/src/filesystem-lock.js";',
    'export { parseLinks } from "@superbee/core/src/bundle.js";',
    'void import("../../core/src/backend.js");',
    'import lock = require("../../core/src/filesystem-lock.js");',
    'require("../../core/src/memory-backend.js");',
    'import { createRequire as createLoader } from "node:module";',
    'const load = createLoader(import.meta.url);',
    'load("../../core/src/filesystem-lock.js");',
    'const coreUrl = new URL("../../core/src/remote-backend.js", import.meta.url);',
    'void import(coreUrl.href);',
    'void import(new URL("../../core/src/memory-backend.js", import.meta.url));',
    'import * as moduleApi from "node:module";',
    'const namespacedLoad = moduleApi.createRequire(import.meta.url);',
    'namespacedLoad("../../core/src/backend.js");',
    'void import("../../core/dist/index.js");',
    `void import(${JSON.stringify(`file://${path.join(DIST_ROOT, "private.js")}`)});`,
    'import { privateCoreThing } from "@superbee/core/private";',
    'import { isTerminal } from "@superbee/core/kinds";',
  ].join("\n");

  assert.deepEqual(sourceBypassViolationsIn(syntheticFile, source), [
    'packages/cli/test/source-bypass.ts:1 — core package-boundary bypass "../../core/src/filesystem-lock.js"',
    'packages/cli/test/source-bypass.ts:2 — core package-boundary bypass "@superbee/core/src/bundle.js"',
    'packages/cli/test/source-bypass.ts:3 — core package-boundary bypass "../../core/src/backend.js"',
    'packages/cli/test/source-bypass.ts:4 — core package-boundary bypass "../../core/src/filesystem-lock.js"',
    'packages/cli/test/source-bypass.ts:5 — core package-boundary bypass "../../core/src/memory-backend.js"',
    'packages/cli/test/source-bypass.ts:8 — core package-boundary bypass "../../core/src/filesystem-lock.js"',
    'packages/cli/test/source-bypass.ts:10 — core package-boundary bypass "../../core/src/remote-backend.js"',
    'packages/cli/test/source-bypass.ts:11 — core package-boundary bypass "../../core/src/memory-backend.js"',
    'packages/cli/test/source-bypass.ts:14 — core package-boundary bypass "../../core/src/backend.js"',
    'packages/cli/test/source-bypass.ts:15 — core package-boundary bypass "../../core/dist/index.js"',
    `packages/cli/test/source-bypass.ts:16 — core package-boundary bypass "file://${path.join(DIST_ROOT, "private.js")}"`,
    'packages/cli/test/source-bypass.ts:17 — core package-boundary bypass "@superbee/core/private"',
  ]);
});
