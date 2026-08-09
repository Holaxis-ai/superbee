import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const SRC = join(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importedLocals(source: ts.SourceFile, moduleName: string, exported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.getText(source).slice(1, -1) !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === exported) names.add(element.name.text);
    }
  }
  return names;
}

function containingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
  }
  return undefined;
}

test("parseArgs bypasses and arity deferrals have an AST/import-aware closed allowlist", () => {
  const direct: string[] = [];
  const selectorReasons: string[] = [];
  const deferredReasons: string[] = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const parseArgsNames = importedLocals(source, "node:util", "parseArgs");
    const parseHelpers = new Set([
      ...importedLocals(source, "../args.js", "parseOrUsage"),
      ...importedLocals(source, "../../args.js", "parseOrUsage"),
      ...importedLocals(source, "../args.js", "parseSelectorOrUsage"),
    ]);
    const selectorHelpers = importedLocals(source, "../args.js", "parseSelectorOrUsage");
    const deferHelpers = new Set([
      ...importedLocals(source, "../args.js", "deferArity"),
      ...importedLocals(source, "../../args.js", "deferArity"),
    ]);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (parseArgsNames.has(node.expression.text)) {
          let joined = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parseHelpers.has(parent.expression.text)) {
              joined = true;
              break;
            }
            if (ts.isFunctionDeclaration(parent)) break;
          }
          if (!joined) direct.push(`${relative(SRC, file)}:${containingFunctionName(node) ?? "<module>"}`);
        }
        if (selectorHelpers.has(node.expression.text)) {
          const argument = node.arguments[2];
          selectorReasons.push(argument && ts.isStringLiteral(argument) ? argument.text : "<nonliteral>");
        }
        if (deferHelpers.has(node.expression.text)) {
          const argument = node.arguments[0];
          deferredReasons.push(argument && ts.isStringLiteral(argument) ? argument.text : "<nonliteral>");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(direct.sort(), [
    "cli.ts:hoistLeadingGlobalFlags",
    "cli.ts:isGlobalOnlyHomeInvocation",
    "commands/home.ts:parseHomeArgs",
  ]);
  assert.deepEqual(selectorReasons.sort(), [
    "selector:bundle", "selector:catalog", "selector:hook", "selector:index",
    "selector:kind", "selector:skill", "selector:view",
  ]);
  assert.deepEqual(deferredReasons.sort(), ["doc-update:token-normalization", "new:schema"]);
});
