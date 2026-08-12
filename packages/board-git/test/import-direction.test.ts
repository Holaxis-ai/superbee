/**
 * The board-git import-direction gate (board-git A1, superseding the CLI's A0 seed test
 * `package-clean-imports.test.ts` — removed in the same unit).
 *
 * THE RULE, with NO allowlist: every module under `packages/board-git/src` may reach ONLY
 *   - node builtins (either `node:`-prefixed or bare — `isBuiltin` decides, not a list),
 *   - `@superbee/core` (and its subpaths), and
 *   - relative specifiers that RESOLVE INSIDE this package's `src/` (a `../` that escapes the
 *     package — e.g. into the CLI — is a violation even though it is "relative").
 * Anything else — the CLI, `@superbee/server`, any npm package — fails the gate.
 *
 * The SAME walk also covers `packages/board-git/test/`, under the pragmatic TEST-file rule (A1
 * review finding 3): builtins, core, in-package sources (relative specifiers resolving anywhere
 * under the package root — `src/` or `test/`), and `"typescript"` (the gate's own devDep, used to
 * parse the AST it walks) — but never `packages/cli` sources. This is the direction the harness
 * itself must never cross; the other direction (the CLI's tests importing board-git's `git-harness`
 * fixture) is legal and unaffected.
 *
 * The walk uses the TypeScript AST (typescript is already a devDependency), not regexes, so the
 * seed test's known gaps (PR #76 review finding) are closed by construction:
 *   - bare side-effect imports (`import "./x.js"`) — an ImportDeclaration with no import clause
 *     still carries a moduleSpecifier;
 *   - multi-line import/export statements — the parser is layout-blind;
 *   - `export ... from "…"` — ExportDeclaration.moduleSpecifier;
 *   - CommonJS `require()` and `createRequire` — ANY reference to either identifier is flagged
 *     (they manufacture an import channel this gate cannot see through), not just call forms;
 *   - dynamic `import()` — a string-literal specifier is checked like any other; a NON-literal
 *     specifier (template literal, variable, expression) is a violation outright — conservative
 *     is correct here.
 *
 * The gate also pins the package manifest: runtime `dependencies` must be exactly
 * `@superbee/core` — a dependency edge is an import edge in disguise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, "..");
const SRC_DIR = path.resolve(here, "../src");
const TEST_DIR = here;

/** A specifier is legal iff builtin, core, or relative-and-inside-src. */
function specifierViolation(file: string, specifier: string): string | null {
  if (isBuiltin(specifier)) return null;
  if (specifier === "@superbee/core" || specifier.startsWith("@superbee/core/")) {
    return null;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved === SRC_DIR || resolved.startsWith(`${SRC_DIR}${path.sep}`)) return null;
    return `relative import escapes the package src/: "${specifier}"`;
  }
  return `disallowed specifier "${specifier}"`;
}

/**
 * A specifier is legal for a TEST file iff builtin, core, `"typescript"` (the gate's own
 * devDep), or relative-and-resolves-inside-the-package (`src/` OR `test/`) — never `packages/cli`,
 * which resolves outside {@link PKG_ROOT} by construction.
 */
function testSpecifierViolation(file: string, specifier: string): string | null {
  if (isBuiltin(specifier)) return null;
  if (specifier === "@superbee/core" || specifier.startsWith("@superbee/core/")) {
    return null;
  }
  if (specifier === "typescript") return null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved === PKG_ROOT || resolved.startsWith(`${PKG_ROOT}${path.sep}`)) return null;
    return `relative import escapes the package: "${specifier}"`;
  }
  return `disallowed specifier "${specifier}"`;
}

/** Collect every violation in one source file via the TypeScript AST. */
function violationsIn(
  file: string,
  source: string,
  checkSpecifier: (file: string, specifier: string) => string | null,
): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const violations: string[] = [];
  const flag = (node: ts.Node, why: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`${path.relative(PKG_ROOT, file)}:${line + 1} — ${why}`);
  };

  const visit = (node: ts.Node): void => {
    // Static imports (incl. bare side-effect form) and re-exports.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const why = checkSpecifier(file, node.moduleSpecifier.text);
        if (why) flag(node, why);
      } else {
        flag(node, "non-literal module specifier");
      }
    }
    // import type ... = require("…") (TS import-equals form).
    if (ts.isImportEqualsDeclaration(node)) {
      flag(node, "import-equals declaration (a require channel)");
    }
    // Dynamic import(): literal specifiers are checked; anything else is a violation.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        const why = checkSpecifier(file, arg.text);
        if (why) flag(node, why);
      } else {
        flag(node, "dynamic import() with a non-literal specifier");
      }
    }
    // ANY reference to require/createRequire manufactures an unscanned import channel.
    if (ts.isIdentifier(node) && (node.text === "require" || node.text === "createRequire")) {
      flag(node, `reference to "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

async function walkSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkSources(full)));
    else if (entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("import direction: no board-git src module reaches the CLI (or anything beyond node + core)", async () => {
  const files = await walkSources(SRC_DIR);
  assert.ok(files.length >= 8, `expected the package's modules, found ${files.length} — wrong dir?`);
  const violations: string[] = [];
  for (const file of files) {
    violations.push(...violationsIn(file, await readFile(file, "utf8"), specifierViolation));
  }
  assert.deepEqual(violations, [], `import-direction violations:\n${violations.join("\n")}`);
});

test("import direction: no board-git TEST module reaches packages/cli sources", async () => {
  const files = await walkSources(TEST_DIR);
  assert.ok(files.length >= 5, `expected the package's test modules, found ${files.length} — wrong dir?`);
  const violations: string[] = [];
  for (const file of files) {
    violations.push(...violationsIn(file, await readFile(file, "utf8"), testSpecifierViolation));
  }
  assert.deepEqual(violations, [], `import-direction (test) violations:\n${violations.join("\n")}`);
});

test("import direction: the manifest's runtime dependencies are exactly @superbee/core", async () => {
  const manifest = JSON.parse(await readFile(path.resolve(here, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@superbee/core"]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});
