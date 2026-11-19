import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("view-host source imports only core and its own source, never Node", async () => {
  const violations = [];
  for (const name of await readdir(src)) {
    if (!name.endsWith(".ts")) continue;
    const file = path.join(src, name);
    const tree = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
        if (!(specifier === "@superbee/core" || specifier.startsWith("@superbee/core/") || specifier.startsWith("./")))
          violations.push(`${name}: ${specifier || "non-literal import"}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(violations, []);
});

test("view-host's one runtime dependency is core", () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@superbee/core"]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test("every view-host entry bundles for a browser with no Node global", async () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const bundled = await build({
      entryPoints: [path.join(root, target.default)],
      bundle: true, platform: "browser", format: "iife", globalName: "Entry", write: false, logLevel: "silent", metafile: true,
    });
    assert.ok(Object.values(bundled.metafile.outputs).every((output) => output.imports.length === 0), subpath);
    // The entry loads in a realm with browser globals only.
    const sandbox = { TextEncoder, TextDecoder, URL, AbortController, structuredClone, setTimeout, clearTimeout };
    for (const name of ["process", "Buffer", "require"]) assert.equal(runInNewContext(`typeof ${name}`, sandbox), "undefined");
    runInNewContext(bundled.outputFiles[0].text, sandbox);
    assert.ok(Object.keys(sandbox.Entry).length > 0, subpath);
  }
});
