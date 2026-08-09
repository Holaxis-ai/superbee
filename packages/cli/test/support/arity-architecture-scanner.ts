import ts from "typescript";

export type DecisionShape =
  | { kind: "leaf"; value: string }
  | { kind: "deferred"; value: string }
  | { kind: "invalid"; value: string };

export interface CallFact {
  file: string;
  functionName: string;
}

export interface DecisionFact extends CallFact {
  decision: DecisionShape;
}

export interface SelectorFact extends CallFact {
  reason: string;
}

export interface ArchitectureFacts {
  directParseArgs: CallFact[];
  parseDecisions: DecisionFact[];
  selectorCalls: SelectorFact[];
  deferFactoryCalls: Array<CallFact & { reason: string }>;
}

interface Binding {
  module: string;
  exported: string;
}

function isArgsModule(moduleName: string): boolean {
  return moduleName === "./args.js" || /^(?:\.\.\/)+args\.js$/.test(moduleName);
}

function isNodeUtilModule(moduleName: string): boolean {
  return moduleName === "node:util" || moduleName === "util";
}

function containingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) return current.name.text;
  }
  return "<module>";
}

function literal(node: ts.Expression | undefined): string {
  return node && ts.isStringLiteralLike(node) ? node.text : "<nonliteral>";
}

/** Scan one TypeScript source using resolved import bindings, not callee spelling. */
export function scanArityArchitecture(file: string, text: string): ArchitectureFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Map<string, Binding>();
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (statement.importClause?.name) namespaces.set(statement.importClause.name.text, moduleName);
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, moduleName);
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        named.set(element.name.text, {
          module: moduleName,
          exported: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }

  const ownsArgsHelpers = file === "args.ts" || file.endsWith("/args.ts");
  const resolveCall = (expression: ts.LeftHandSideExpression): Binding | undefined => {
    if (ts.isIdentifier(expression)) {
      const imported = named.get(expression.text);
      if (imported) return imported;
      if (ownsArgsHelpers && ["parseOrUsage", "parseSelectorOrUsage", "leafArity", "deferArity"].includes(expression.text)) {
        return { module: "./args.js", exported: expression.text };
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const moduleName = namespaces.get(expression.expression.text);
      return moduleName ? { module: moduleName, exported: expression.name.text } : undefined;
    }
    return undefined;
  };

  const facts: ArchitectureFacts = {
    directParseArgs: [],
    parseDecisions: [],
    selectorCalls: [],
    deferFactoryCalls: [],
  };
  const callFact = (node: ts.Node): CallFact => ({ file, functionName: containingFunctionName(node) });

  const classifyDecision = (argument: ts.Expression | undefined): DecisionShape => {
    if (!argument || !ts.isCallExpression(argument)) return { kind: "invalid", value: argument?.getText(source) ?? "<missing>" };
    const target = resolveCall(argument.expression);
    if (!target || !isArgsModule(target.module)) return { kind: "invalid", value: argument.getText(source) };
    if (target.exported === "leafArity") return { kind: "leaf", value: literal(argument.arguments[0]) };
    if (target.exported === "deferArity") return { kind: "deferred", value: literal(argument.arguments[0]) };
    return { kind: "invalid", value: argument.getText(source) };
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = resolveCall(node.expression);
      if (target && isNodeUtilModule(target.module) && target.exported === "parseArgs") {
        let joined = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (!ts.isCallExpression(parent)) continue;
          const owner = resolveCall(parent.expression);
          if (owner && isArgsModule(owner.module) && (owner.exported === "parseOrUsage" || owner.exported === "parseSelectorOrUsage")) {
            joined = true;
            break;
          }
        }
        if (!joined) facts.directParseArgs.push(callFact(node));
      }
      if (target && isArgsModule(target.module) && target.exported === "parseOrUsage") {
        facts.parseDecisions.push({ ...callFact(node), decision: classifyDecision(node.arguments[2]) });
      }
      if (target && isArgsModule(target.module) && target.exported === "parseSelectorOrUsage") {
        facts.selectorCalls.push({ ...callFact(node), reason: literal(node.arguments[2]) });
      }
      if (target && isArgsModule(target.module) && target.exported === "deferArity") {
        facts.deferFactoryCalls.push({ ...callFact(node), reason: literal(node.arguments[0]) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}
