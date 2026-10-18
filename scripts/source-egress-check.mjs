/**
 * The static egress check for source profile modules. Node and Workers give every module `fetch`,
 * `WebSocket` and dynamic `import()`, and the browser bundle gate catches Node builtins only, so a
 * profile could reach the network around the engine's guarded transport. This pass refuses every
 * global outside a short allowlist, every package import outside an allowlist and every relative
 * import outside the scanned roots, dynamic `import()`, `eval`, `Function`, the prototype and
 * property-definition names, writes to a global or to anything reached from one, `this` outside a
 * class body, and CommonJS modules. A profile runs in the engine's realm, so tampering with a
 * built-in would reach the guard itself; review stays the main control, because a key computed at
 * run time can still reach those names and no static pass can see it.
 *
 * Globals are resolved by the TypeScript checker over the type-erased module, so a local binding
 * shadowing a global is allowed, a type position is ignored, and a `declare const fetch` cannot
 * pose as a local. Imports are read from the source as written, since a runtime that strips types
 * loads every import that is not `import type`.
 *
 *   node scripts/source-egress-check.mjs <file-or-directory>...
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
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
/** Property names that reach or redefine prototypes and built-ins. */
const REFUSED_KEYS = Object.freeze([
  "constructor", "__proto__", "prototype", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  // Copying onto an object, and walking descriptors, reach a built-in's prototype by value.
  "assign", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols",
]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|[cm]?js)$/;

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");

/**
 * The default import rule: an allowed package, or a relative module that is itself scanned or lies
 * inside one of `roots`, so nothing a scanned module imports escapes the check.
 */
function defaultAllowImport(files, roots) {
  // Compared through real paths, so a link inside a root cannot stand for a module outside it.
  const real = (file) => {
    try { return realpathSync(file); } catch { return path.resolve(file); }
  };
  const scanned = new Set(files.map((file) => real(file.path)));
  const inside = roots.map(real);
  return (specifier, file) => {
    if (!isRelative(specifier)) return EGRESS_ALLOWED_IMPORTS.includes(specifier);
    const target = path.resolve(path.dirname(file), specifier);
    const candidates = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.mjs$/, ".mts")].map(real);
    return candidates.some((candidate) => scanned.has(candidate) || inside.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`)));
  };
}

const COMMONJS = /\.c[jt]s$/;

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
  if (ts.isImportSpecifier(parent) || ts.isNamespaceExport(parent) || ts.isImportAttribute(parent)) return false;
  // `export { a } from "m"` names another module's export; `export { a }` reads the local `a`.
  if (ts.isExportSpecifier(parent)) return parent.parent.parent.moduleSpecifier === undefined && (parent.propertyName ?? parent.name) === node;
  if ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  if (ts.isMetaProperty(parent)) return false;
  return true;
}

/** Whether a `this` lies in a class body rather than a function, an object literal or the module. */
function inClassBody(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isSourceFile(parent)) return false;
    const member = ts.isMethodDeclaration(parent) || ts.isConstructorDeclaration(parent) || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent);
    if (member) return Boolean(parent.parent && (ts.isClassDeclaration(parent.parent) || ts.isClassExpression(parent.parent)));
  }
  return false;
}

/** The identifier a member chain starts from (`a` in `a.b[c].d`), or the expression itself. */
function chainRoot(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Violations in a set of modules, as `file:line: message`. Global lines refer to the type-erased
 * module, which keeps most lines of a TypeScript source.
 *
 * @param {ReadonlyArray<{ path: string, text: string }>} files
 * @param {{ globals?: readonly string[], roots?: readonly string[], allowImport?: (specifier: string, file: string) => boolean, allowKeys?: readonly string[] }} [options]
 *   `allowKeys` admits refused property names, for trusted engine code only.
 * @returns {string[]}
 */
export function egressViolations(files, options = {}) {
  const allowed = new Set([...EGRESS_ALLOWED_GLOBALS, ...(options.globals ?? []), ...IMPLICIT]);
  for (const name of NEVER_ALLOWED) allowed.delete(name);
  const refusedKeys = new Set(REFUSED_KEYS.filter((key) => !(options.allowKeys ?? []).includes(key)));
  const allowImport = options.allowImport ?? defaultAllowImport(files, options.roots ?? []);
  const violations = [];
  const erased = new Map();
  for (const file of files) {
    if (COMMONJS.test(file.path)) violations.push(`${file.path}: a CommonJS module is refused; sloppy-mode code reaches the global object`);
    violations.push(...importViolations(file.path, file.text, allowImport));
    const output = ts.transpileModule(file.text, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
    });
    for (const diagnostic of output.diagnostics ?? []) {
      violations.push(`${file.path}: does not compile: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    // Read back as TypeScript: a JavaScript binder turns a top-level `JSON.parse = ...` into a
    // declaration in the module, which would make the global look local.
    erased.set(`${file.path}.egress.ts`, { file: file.path, text: output.outputText });
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
    ? ts.createSourceFile(name, erased.get(name).text, version, true, ts.ScriptKind.TS)
    : getSourceFile(name, version, onError, shouldCreate));
  host.fileExists = (name) => erased.has(name) || fileExists(name);
  host.readFile = (name) => (erased.has(name) ? erased.get(name).text : readFile(name));
  const program = ts.createProgram([...erased.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();

  // A symbol with any declaration outside the scanned modules is a global, even when a module adds
  // to it.
  const isGlobal = (symbol) => {
    if (!symbol) return true;
    if (symbol.flags & ts.SymbolFlags.Alias) return false;
    const declarations = symbol.declarations ?? [];
    return declarations.length === 0 || declarations.some((declaration) => !erased.has(declaration.getSourceFile().fileName));
  };

  for (const [name, { file }] of erased) {
    const source = program.getSourceFile(name);
    const flag = (node, message) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${file}:${line + 1}: ${message}`);
    };
    const symbolOf = (node) => (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node));
    /** Flag a write whose target is a global or reached from one, destructuring targets included. */
    const checkTarget = (target, what) => {
      if (ts.isArrayLiteralExpression(target)) {
        for (const element of target.elements) checkTarget(ts.isSpreadElement(element) ? element.expression : element, what);
      } else if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          if (ts.isPropertyAssignment(property)) checkTarget(property.initializer, what);
          else if (ts.isShorthandPropertyAssignment(property)) checkTarget(property.name, what);
          else if (ts.isSpreadAssignment(property)) checkTarget(property.expression, what);
        }
      } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        checkTarget(target.left, what);
      } else if (!ts.isOmittedExpression(target)) {
        const root = chainRoot(target);
        if (ts.isIdentifier(root) && isGlobal(symbolOf(root))) flag(target, `${what} the global ${root.text} or something reached from it`);
      }
    };
    /** The literal text of a property name, or undefined for a computed one built at run time. */
    const nameText = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name))
      ? name.text
      : name && ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression)) ? name.expression.text : undefined);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) flag(node, "dynamic import()");
      // A refused key read by destructuring or named in an object literal (an assignment pattern
      // included) reaches the same value as reading it by property access.
      const named = ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) ? nameText(node.propertyName ?? node.name)
        : ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) ? nameText(node.name)
          : undefined;
      if (named !== undefined && refusedKeys.has(named)) flag(node, `names ${named}`);
      if (ts.isPropertyAccessExpression(node) && refusedKeys.has(node.name.text)) flag(node, `reads ${node.name.text}`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && refusedKeys.has(node.text)) flag(node, `names ${node.text}`);
      if (node.kind === ts.SyntaxKind.ThisKeyword && !inClassBody(node)) flag(node, "uses this outside a class body");
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        checkTarget(node.left, "assigns to");
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkTarget(node.operand, "updates");
      if (ts.isDeleteExpression(node)) checkTarget(node.expression, "deletes from");
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) checkTarget(node.initializer, "assigns to");
      if (ts.isIdentifier(node) && isReference(node)) {
        if (isGlobal(symbolOf(node)) && !allowed.has(node.text)) flag(node, `names the global ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

/** Every module under the given files and directories, declaration files excluded, in path order. */
export function collectSourceFiles(roots) {
  if (!roots.length) throw new Error("usage: node scripts/source-egress-check.mjs <file-or-directory>...");
  const out = [];
  const take = (file) => {
    if (SOURCE_EXTENSIONS.test(file) && !/\.d\.[cm]?ts$/.test(file)) out.push({ path: file, text: readFileSync(file, "utf8") });
  };
  // Directory entries come from one read, so nothing is checked and then reopened. A symlink is
  // followed: to a directory it is walked, to a module it is read; a dangling one is skipped. Each
  // directory is walked once by its real path, so a link loop ends.
  const visited = new Set();
  const walk = (dir, entries) => {
    let real;
    try { real = realpathSync(dir); } catch { real = path.resolve(dir); }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, readdirSync(full, { withFileTypes: true }));
      else if (entry.isFile()) take(full);
      else if (entry.isSymbolicLink()) {
        let linked;
        try {
          linked = readdirSync(full, { withFileTypes: true });
        } catch (error) {
          if (error?.code === "ENOTDIR") take(full);
          else if (error?.code !== "ENOENT") throw error;
          continue;
        }
        walk(full, linked);
      }
    }
  };
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOTDIR") throw error;
      take(root);
      continue;
    }
    walk(root, entries);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  const roots = process.argv.slice(2);
  const files = collectSourceFiles(roots);
  const violations = egressViolations(files, { roots });
  for (const violation of violations) console.error(violation);
  console.log(`${files.length} module(s) checked, ${violations.length} violation(s)`);
  // A mistyped or empty root checks nothing, which is not a pass.
  process.exit(violations.length || files.length === 0 ? 1 : 0);
}
