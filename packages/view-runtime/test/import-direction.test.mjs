import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const src = path.join(root, "src");

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function allowed(specifier) {
  return (
    isBuiltin(specifier) ||
    specifier === "@superbee/core" ||
    specifier.startsWith("@superbee/core/") ||
    specifier.startsWith("./")
  );
}

test("view-runtime imports only Node, core, and its own source", async () => {
  const violations = [];
  for (const file of await sourceFiles(src)) {
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        if (!specifier || !allowed(specifier)) {
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
          violations.push(`${path.relative(root, file)}:${line + 1} — ${specifier || "non-literal import"}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(violations, []);
});

test("view-runtime manifest depends only on core", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@superbee/core"]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});
