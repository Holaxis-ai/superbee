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

test("mcp-app source reaches only its host-neutral dependencies and never the CLI", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        if (!specifier || !allowed(file, specifier)) {
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
          violations.push(
            `${path.relative(packageRoot, file)}:${line + 1} — ${specifier || "non-literal import"}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(violations, []);
});

test("mcp-app manifest has no CLI dependency", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, "@superbee/cli"), false);
});
