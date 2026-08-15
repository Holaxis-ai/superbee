import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const sourceRoot = path.join(packageRoot, "src");

const allowedPackageRoots = [
  "@modelcontextprotocol/ext-apps",
  "@modelcontextprotocol/sdk",
  "@superbee/core",
  "@superbee/markdown-renderer",
  "@superbee/view-runtime",
] as const;

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function allowed(file: string, specifier: string): boolean {
  if (
    isBuiltin(specifier) ||
    specifier === "zod" ||
    allowedPackageRoots.some(
      (root) => specifier === root || specifier.startsWith(`${root}/`),
    )
  ) return true;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`);
}

function violationsIn(file: string, source: string): string[] {
  const violations: string[] = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const flag = (node: ts.Node, reason: string): void => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    violations.push(`${path.relative(packageRoot, file)}:${line + 1} — ${reason}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      if (!specifier || !allowed(file, specifier)) {
        flag(node, specifier || "non-literal import");
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      flag(node, "import-equals declaration");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const specifier = argument && ts.isStringLiteralLike(argument)
        ? argument.text
        : "";
      if (!specifier || !allowed(file, specifier)) {
        flag(node, specifier || "non-literal dynamic import");
      }
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === "require" || node.text === "createRequire")
    ) {
      flag(node, `reference to "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
}

test("mcp-app source reaches only its host-neutral dependencies and never the CLI", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles(sourceRoot)) {
    violations.push(...violationsIn(file, await readFile(file, "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("the import gate rejects indirect upward import channels", () => {
  const file = path.join(sourceRoot, "probe.ts");
  for (const source of [
    `import "@superbee/cli";`,
    `void import("@superbee/cli");`,
    `import cli = require("@superbee/cli");`,
    `require("@superbee/cli");`,
    `createRequire(import.meta.url)("@superbee/cli");`,
  ]) {
    assert.ok(violationsIn(file, source).length > 0, source);
  }
});

test("mcp-app manifest has no CLI dependency", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, "@superbee/cli"), false);
});
