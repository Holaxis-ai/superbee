/** Enforce the loopback host adapter's package boundary with an AST walk and no path allowlist. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, "..");
const SRC_DIR = path.resolve(PKG_ROOT, "src");
const TEST_DIR = here;

function allowedPackage(specifier: string): boolean {
  return (
    specifier === "@superbee/core" ||
    specifier.startsWith("@superbee/core/") ||
    specifier === "@superbee/server" ||
    specifier.startsWith("@superbee/server/") ||
    specifier === "@superbee/view-runtime" ||
    specifier.startsWith("@superbee/view-runtime/")
  );
}

function specifierViolation(file: string, specifier: string): string | null {
  if (isBuiltin(specifier) || allowedPackage(specifier)) return null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved === SRC_DIR || resolved.startsWith(`${SRC_DIR}${path.sep}`)) return null;
    return `relative import escapes package src/: "${specifier}"`;
  }
  return `disallowed specifier "${specifier}"`;
}

function testSpecifierViolation(file: string, specifier: string): string | null {
  if (isBuiltin(specifier) || allowedPackage(specifier) || specifier === "typescript") return null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved === PKG_ROOT || resolved.startsWith(`${PKG_ROOT}${path.sep}`)) return null;
    return `relative import escapes package: "${specifier}"`;
  }
  return `disallowed specifier "${specifier}"`;
}

function violationsIn(
  file: string,
  source: string,
  checkSpecifier: (file: string, specifier: string) => string | null,
): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const flag = (node: ts.Node, why: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`${path.relative(PKG_ROOT, file)}:${line + 1} — ${why}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const why = checkSpecifier(file, node.moduleSpecifier.text);
        if (why) flag(node, why);
      } else flag(node, "non-literal module specifier");
    }
    if (ts.isImportEqualsDeclaration(node)) flag(node, "import-equals declaration");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        const why = checkSpecifier(file, arg.text);
        if (why) flag(node, why);
      } else flag(node, "dynamic import() with a non-literal specifier");
    }
    if (ts.isIdentifier(node) && (node.text === "require" || node.text === "createRequire")) {
      flag(node, `reference to "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test("import direction: ui-server reaches only node, core, server, view-runtime, and its own source", async () => {
  const files = await walk(SRC_DIR);
  assert.ok(files.length >= 9, `expected the extracted runtime modules, found ${files.length}`);
  const violations: string[] = [];
  for (const file of files) violations.push(...violationsIn(file, await readFile(file, "utf8"), specifierViolation));
  assert.deepEqual(violations, [], `import-direction violations:\n${violations.join("\n")}`);
});

test("import direction: ui-server tests cannot reach CLI sources", async () => {
  const files = await walk(TEST_DIR);
  const violations: string[] = [];
  for (const file of files) {
    violations.push(...violationsIn(file, await readFile(file, "utf8"), testSpecifierViolation));
  }
  assert.deepEqual(violations, [], `test import-direction violations:\n${violations.join("\n")}`);
});

test("import direction: manifest dependencies are exactly core, server, and view-runtime", async () => {
  const manifest = JSON.parse(await readFile(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [
    "@superbee/core",
    "@superbee/server",
    "@superbee/view-runtime",
  ]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});
