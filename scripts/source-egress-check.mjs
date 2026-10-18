/**
 * The static egress check for source profile modules. Node and Workers give every module `fetch`,
 * `WebSocket` and dynamic `import()`, and the browser bundle gate catches Node builtins only, so a
 * profile could reach the network around the engine's guarded transport. This pass refuses every
 * global outside a short allowlist, every module import outside an allowlist, dynamic `import()`,
 * `eval`, `Function` and `constructor` access. Review stays the main control: a key computed at
 * run time can still reach `constructor`, which no static pass can see.
 *
 * Globals are resolved by the TypeScript checker over the type-erased module, so a local binding
 * shadowing a global is allowed, a type position is ignored, and a `declare const fetch` cannot
 * pose as a local. Imports are read from the source as written, since a runtime that strips types
 * loads every import that is not `import type`.
 *
 *   node scripts/source-egress-check.mjs <file-or-directory>...
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { isMainModule } from "./is-main-module.mjs";

/** The globals a profile may name. */
export const EGRESS_ALLOWED_GLOBALS = Object.freeze([
  "Array", "Boolean", "Date", "Error", "Infinity", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise",
  "RangeError", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TextDecoder", "TextEncoder", "TypeError",
  "URL", "URLSearchParams", "Uint8Array", "decodeURIComponent", "encodeURIComponent", "isFinite", "isNaN",
  "parseFloat", "parseInt", "undefined",
]);

/** The packages a profile may import besides its own relative modules. */
export const EGRESS_ALLOWED_IMPORTS = Object.freeze(["@superbee/core/source-engine", "@superbee/core/connectors"]);

/** Refused whatever a caller adds to the allowlist. */
const NEVER_ALLOWED = new Set(["eval", "Function", "globalThis", "self", "window", "global"]);
/** Bound in every function, never a route to the global object in a module. */
const IMPLICIT = new Set(["arguments"]);
const REFUSED_KEYS = new Set(["constructor", "__proto__"]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|[cm]?js)$/;

const defaultAllowImport = (specifier) => specifier.startsWith("./") || specifier.startsWith("../") || EGRESS_ALLOWED_IMPORTS.includes(specifier);

const scriptKind = (file) => (/\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

/** Imports and exports a runtime loads, read from the source as written. */
function importViolations(file, text, allowImport) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const violations = [];
  const flag = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${file}:${line + 1}: ${message}`);
  };
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      if (!statement.isTypeOnly) flag(statement, "import-equals declaration");
      continue;
    }
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
    if (typeOnly) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) { flag(statement, "non-literal module specifier"); continue; }
    const specifier = statement.moduleSpecifier.text;
    if (!allowImport(specifier, file)) flag(statement, `imports "${specifier}"`);
  }
  return violations;
}

/** Whether an identifier node reads a binding, rather than naming a property, a declaration or a label. */
function isReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
    || ts.isClassExpression(parent) || ts.isParameter(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceExport(parent)) return false;
  // `export { a } from "m"` names another module's export; `export { a }` reads the local `a`.
  if (ts.isExportSpecifier(parent)) return parent.parent.parent.moduleSpecifier === undefined && (parent.propertyName ?? parent.name) === node;
  if ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  if (ts.isMetaProperty(parent)) return false;
  return true;
}

/**
 * Violations in a set of modules, as `file:line: message`. Global lines refer to the type-erased
 * module, which keeps most lines of a TypeScript source.
 *
 * @param {ReadonlyArray<{ path: string, text: string }>} files
 * @param {{ globals?: readonly string[], allowImport?: (specifier: string, file: string) => boolean }} [options]
 * @returns {string[]}
 */
export function egressViolations(files, options = {}) {
  const allowed = new Set([...EGRESS_ALLOWED_GLOBALS, ...(options.globals ?? []), ...IMPLICIT]);
  for (const name of NEVER_ALLOWED) allowed.delete(name);
  const allowImport = options.allowImport ?? defaultAllowImport;
  const violations = [];
  const erased = new Map();
  for (const file of files) {
    violations.push(...importViolations(file.path, file.text, allowImport));
    const output = ts.transpileModule(file.text, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
    });
    for (const diagnostic of output.diagnostics ?? []) {
      violations.push(`${file.path}: does not compile: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    erased.set(`${file.path}.egress.js`, { file: file.path, text: output.outputText });
  }

  const { options: compilerOptions } = ts.convertCompilerOptionsFromJson(
    { allowJs: true, checkJs: false, noEmit: true, noResolve: true, target: "es2022", module: "esnext", lib: ["es2022"], types: [] },
    ".",
  );
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, version, onError, shouldCreate) => (erased.has(name)
    ? ts.createSourceFile(name, erased.get(name).text, version, true, ts.ScriptKind.JS)
    : getSourceFile(name, version, onError, shouldCreate));
  host.fileExists = (name) => erased.has(name) || fileExists(name);
  host.readFile = (name) => (erased.has(name) ? erased.get(name).text : readFile(name));
  const program = ts.createProgram([...erased.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();

  const isGlobal = (symbol) => {
    if (!symbol) return true;
    if (symbol.flags & ts.SymbolFlags.Alias) return false;
    const declarations = symbol.declarations ?? [];
    return declarations.length === 0 || declarations.every((declaration) => !erased.has(declaration.getSourceFile().fileName));
  };

  for (const [name, { file }] of erased) {
    const source = program.getSourceFile(name);
    const flag = (node, message) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${file}:${line + 1}: ${message}`);
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) flag(node, "dynamic import()");
      if (ts.isPropertyAccessExpression(node) && REFUSED_KEYS.has(node.name.text)) flag(node, `reads ${node.name.text}`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && REFUSED_KEYS.has(node.text)) flag(node, `names ${node.text}`);
      if (ts.isIdentifier(node) && isReference(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node);
        if (isGlobal(symbol) && !allowed.has(node.text)) flag(node, `names the global ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

/** Every module under the given files and directories, declaration files excluded, in path order. */
export function collectSourceFiles(roots) {
  const out = [];
  const walk = (entry) => {
    if (statSync(entry).isDirectory()) {
      for (const name of readdirSync(entry).sort()) walk(path.join(entry, name));
    } else if (SOURCE_EXTENSIONS.test(entry) && !/\.d\.[cm]?ts$/.test(entry)) {
      out.push({ path: entry, text: readFileSync(entry, "utf8") });
    }
  };
  for (const root of roots) walk(root);
  return out;
}

if (isMainModule(import.meta.url)) {
  const roots = process.argv.slice(2);
  if (!roots.length) {
    console.error("usage: node scripts/source-egress-check.mjs <file-or-directory>...");
    process.exit(2);
  }
  const files = collectSourceFiles(roots);
  const violations = egressViolations(files);
  for (const violation of violations) console.error(violation);
  console.log(`${files.length} module(s) checked, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
