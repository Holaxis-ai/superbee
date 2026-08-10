import ts from "typescript";

export type OwnedParserApi =
  | "parseLeafOrUsage"
  | "parseSelectorOrUsage"
  | "parseNewSchemaPhaseOrUsage"
  | "parseDocUpdateTokensOrUsage";

export interface CallFact {
  file: string;
  functionName: string;
}

export interface OwnedCallFact extends CallFact {
  api: OwnedParserApi;
  leaf: string;
}

export interface ArchitectureViolation extends CallFact {
  origin: string;
  reason: string;
  site: string;
}

export interface ArchitectureFacts {
  directParseArgs: CallFact[];
  ownedCalls: OwnedCallFact[];
  directArityAssertions: CallFact[];
  runAxiCliCalls: Array<CallFact & { commands: string }>;
  violations: ArchitectureViolation[];
}

interface Binding {
  module: string;
  exported: string;
}

const OWNED_APIS = new Set<OwnedParserApi>([
  "parseLeafOrUsage",
  "parseSelectorOrUsage",
  "parseNewSchemaPhaseOrUsage",
  "parseDocUpdateTokensOrUsage",
]);

function isArgsModule(moduleName: string): boolean {
  return moduleName === "./args.js" || /^(?:\.\.\/)+args\.js$/.test(moduleName);
}

function isArityModule(moduleName: string): boolean {
  return moduleName === "./positional-arity.js" || /^(?:\.\.\/)+positional-arity\.js$/.test(moduleName);
}

function isSensitiveModule(moduleName: string): boolean {
  return moduleName === "node:util" || moduleName === "util" || moduleName === "axi-sdk-js" ||
    isArgsModule(moduleName) || isArityModule(moduleName);
}

function isSensitiveBinding(binding: Binding): boolean {
  if (binding.module === "node:util" || binding.module === "util") return binding.exported === "parseArgs" || binding.exported === "default";
  if (binding.module === "axi-sdk-js") return binding.exported === "runAxiCli" || binding.exported === "default";
  if (isArgsModule(binding.module)) return OWNED_APIS.has(binding.exported as OwnedParserApi) || binding.exported === "default";
  return isArityModule(binding.module) && (binding.exported === "assertLeafArity" || binding.exported === "default");
}

function containingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (
      ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) return current.name.text;
  }
  return "<module>";
}

function site(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/**
 * Fail-closed static-ESM architecture scanner. It is a maintainer regression boundary, not a
 * security sandbox: imported sensitive authorities must remain direct calls so aliases, storage,
 * re-exports, namespace destructuring, computed access, and helper indirection are rejected.
 */
export function scanArityArchitecture(file: string, text: string): ArchitectureFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Map<string, Binding>();
  const namespaces = new Map<string, string>();
  const importNodes = new Set<ts.Node>();
  const facts: ArchitectureFacts = {
    directParseArgs: [],
    ownedCalls: [],
    directArityAssertions: [],
    runAxiCliCalls: [],
    violations: [],
  };

  const violation = (node: ts.Node, origin: string, reason: string): void => {
    facts.violations.push({
      file,
      functionName: containingFunctionName(node),
      origin,
      reason,
      site: site(source, node),
    });
  };
  const callFact = (node: ts.Node): CallFact => ({ file, functionName: containingFunctionName(node) });

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) named.set(clause.name.text, { module: moduleName, exported: "default" });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, moduleName);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          named.set(element.name.text, { module: moduleName, exported: element.propertyName?.text ?? element.name.text });
        }
      }
      const mark = (node: ts.Node): void => { importNodes.add(node); ts.forEachChild(node, mark); };
      mark(statement);
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      if (!isSensitiveModule(moduleName)) continue;
      if (!statement.exportClause) {
        violation(statement, moduleName, "star re-export of sensitive module");
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        violation(statement, moduleName, "namespace re-export of sensitive module");
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const exported = element.propertyName?.text ?? element.name.text;
        if (isSensitiveBinding({ module: moduleName, exported })) {
          violation(element, `${moduleName}:${exported}`, "re-export of sensitive authority");
        }
      }
    }

    if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteral(reference.expression) && isSensitiveModule(reference.expression.text)) {
        violation(statement, reference.expression.text, "import-equals access to sensitive module");
      }
    }
  }

  const resolveCall = (expression: ts.LeftHandSideExpression): Binding | undefined => {
    if (ts.isIdentifier(expression)) return named.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const moduleName = namespaces.get(expression.expression.text);
      return moduleName ? { module: moduleName, exported: expression.name.text } : undefined;
    }
    return undefined;
  };

  const leafArgument = (node: ts.CallExpression, api: OwnedParserApi): string => {
    if (api !== "parseLeafOrUsage") return "<classified>";
    const argument = node.arguments[1];
    if (argument && ts.isIdentifier(argument) && argument.text === "HOME_LEAF") return "HOME_LEAF";
    if (
      argument && ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) &&
      argument.expression.text === "CLI_LEAVES"
    ) return `CLI_LEAVES.${argument.name.text}`;
    return argument?.getText(source) ?? "<missing>";
  };

  const directSensitiveCall = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument) && isSensitiveModule(argument.text)) {
          violation(node, argument.text, "dynamic import of sensitive module");
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument) && isSensitiveModule(argument.text)) {
          violation(node, argument.text, "require access to sensitive module");
        }
      }

      const target = resolveCall(node.expression);
      if (target && isSensitiveBinding(target)) {
        directSensitiveCall.add(node.expression);
        if (target.module === "node:util" || target.module === "util") {
          let owned = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (!ts.isCallExpression(parent)) continue;
            const owner = resolveCall(parent.expression);
            if (owner && isArgsModule(owner.module) && OWNED_APIS.has(owner.exported as OwnedParserApi)) {
              owned = true;
              break;
            }
          }
          if (!owned) facts.directParseArgs.push(callFact(node));
        } else if (isArgsModule(target.module) && OWNED_APIS.has(target.exported as OwnedParserApi)) {
          const api = target.exported as OwnedParserApi;
          facts.ownedCalls.push({ ...callFact(node), api, leaf: leafArgument(node, api) });
          if (api === "parseLeafOrUsage" && !/^CLI_LEAVES\.[A-Za-z0-9]+$|^HOME_LEAF$/.test(leafArgument(node, api))) {
            violation(node.arguments[1] ?? node, `${target.module}:${api}`, "ordinary parser requires a direct canonical leaf member");
          }
        } else if (isArityModule(target.module) && target.exported === "assertLeafArity") {
          facts.directArityAssertions.push(callFact(node));
        } else if (target.module === "axi-sdk-js" && target.exported === "runAxiCli") {
          const options = node.arguments[0];
          let commands = "<missing>";
          if (options && ts.isObjectLiteralExpression(options)) {
            const property = options.properties.find((candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === "commands");
            commands = property?.initializer.getText(source) ?? "<missing>";
          }
          facts.runAxiCliCalls.push({ ...callFact(node), commands });
          if (commands !== "RUNTIME_COMMANDS") {
            violation(node, "axi-sdk-js:runAxiCli", "commands must be the direct RUNTIME_COMMANDS identifier");
          }
        } else {
          violation(node, `${target.module}:${target.exported}`, "unapproved sensitive call");
        }
      }
    }

    if (ts.isIdentifier(node) && !importNodes.has(node)) {
      const binding = named.get(node.text);
      if (binding && isSensitiveBinding(binding) && !directSensitiveCall.has(node)) {
        violation(node, `${binding.module}:${binding.exported}`, "sensitive authority used outside a direct call");
      }
      const moduleName = namespaces.get(node.text);
      if (moduleName && isSensitiveModule(moduleName)) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          if (!directSensitiveCall.has(parent)) {
            violation(parent, moduleName, "sensitive namespace member used outside a direct call");
          }
        } else {
          violation(node, moduleName, "sensitive namespace used indirectly");
        }
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const moduleName = namespaces.get(node.expression.text);
      if (moduleName && isSensitiveModule(moduleName)) {
        violation(node, moduleName, "computed access to sensitive namespace");
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}
