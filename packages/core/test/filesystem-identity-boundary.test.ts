/**
 * Non-public boundary assertions for the filesystem identity unit (N1, N2, N4): the public index
 * exports exactly the allowlisted names from the storage modules, the adapter class has exactly
 * the contract shape with no statics, the filesystem is reachable only from the identity and lock
 * modules, and none of the three runtime modules reads the environment. N3 (the packed package)
 * lives in `scripts/package-core-external-proof.test.mjs`.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { FilesystemBackend } from "../src/backend.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(here, "..", "src");
const IDENTITY_MODULES = ["backend.ts", "filesystem-identity.ts", "filesystem-lock.ts"];
const FS_SPECIFIERS = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
const IDENTITY_MODULE = "./filesystem-identity.js";
const IDENTITY_MODULE_PATH = path.join(SOURCE_ROOT, "filesystem-identity");
/** Modules whose require factory hands out a loader this scan cannot follow to its call sites. */
const MODULE_LOADER_SPECIFIERS = new Set(["node:module", "module"]);
/** Names that produce a `require` function, however they are spelled at the access site. */
const REQUIRE_FACTORIES = new Set(["createRequire", "getBuiltinModule"]);
const AMBIENT_SPECIFIERS = new Set(["node:os", "os"]);
/** Ambient host inputs: values that vary with the machine, the user, or the environment. */
const AMBIENT_BINDINGS = new Set(["tmpdir", "homedir", "hostname", "userInfo", "networkInterfaces"]);

async function parse(file: string): Promise<ts.SourceFile> {
  return ts.createSourceFile(file, await readFile(path.join(SOURCE_ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every source module, subdirectories included, named relative to `SOURCE_ROOT`. */
async function sourceModules(dir = SOURCE_ROOT): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceModules(full)));
    else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name)) found.push(path.relative(SOURCE_ROOT, full));
  }
  return found.sort();
}

/** The module specifier of any construct that names a module, or `null` when it names one it cannot resolve. */
function moduleSpecifierOf(node: ts.Node): ts.Expression | null | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (!ts.isCallExpression(node)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0] ?? null;
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") return node.arguments[0] ?? null;
  return undefined;
}

/** A name that yields a `require` function, whether written as an identifier or as a computed key. */
function namesRequireFactory(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) && REQUIRE_FACTORIES.has(node.text)) return node.text;
  if (ts.isStringLiteralLike(node) && REQUIRE_FACTORIES.has(node.text)) return node.text;
  return undefined;
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Ambient host inputs an import brings into a module: the `node:os` specifier in any import form,
 * and any ambient binding by its imported name whatever module it comes from, so a re-export
 * cannot launder one in. Identity keys are a pure fold of the root and `rel` (I4); a machine-,
 * user-, or environment-derived value reaching that derivation would make one logical identity
 * key differently per host, which no runtime assertion downstream can detect.
 */
function ambientImports(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (AMBIENT_SPECIFIERS.has(node.moduleSpecifier.text)) found.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier) && AMBIENT_SPECIFIERS.has(specifier.text)) found.add(specifier.text);
    }
    if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (AMBIENT_BINDINGS.has(imported)) found.add(imported);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

function processEnvAccesses(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const isProcess = (node: ts.Expression): boolean => ts.isIdentifier(node) && node.text === "process";
  const visit = (node: ts.Node): void => {
    const hit =
      (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && node.name.text === "env") ||
      (ts.isElementAccessExpression(node) && isProcess(node.expression)) ||
      (ts.isIdentifier(node) && node.text === "env" && ts.isBindingElement(node.parent));
    if (hit) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

// ── N1: index export allowlist per storage module ─────────────────────────────

test("N1: index.ts exports exactly the allowlisted names from the storage modules", async () => {
  const index = await parse("index.ts");
  const exported = new Map<string, { values: string[]; types: string[] }>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bucket = exported.get(node.moduleSpecifier.text) ?? { values: [], types: [] };
      assert.ok(node.exportClause && ts.isNamedExports(node.exportClause), `index.ts must not re-export * from ${node.moduleSpecifier.text}`);
      for (const element of node.exportClause.elements) {
        const name = element.name.text;
        if (node.isTypeOnly || element.isTypeOnly) bucket.types.push(name);
        else bucket.values.push(name);
      }
      exported.set(node.moduleSpecifier.text, bucket);
    }
    ts.forEachChild(node, visit);
  };
  visit(index);
  const sorted = (bucket: { values: string[]; types: string[] } | undefined) => ({
    values: [...(bucket?.values ?? [])].sort(),
    types: [...(bucket?.types ?? [])].sort(),
  });
  assert.deepEqual(sorted(exported.get("./backend.js")), { values: ["FilesystemBackend"], types: [] });
  assert.deepEqual(sorted(exported.get("./filesystem-lock.js")), {
    values: ["FilesystemMutationLockError", "filesystemMutationLockPath", "withFilesystemMutationLock"],
    types: ["FilesystemMutationLockOptions", "FilesystemMutationLockOwner"],
  });
  assert.equal(exported.has("./filesystem-identity.js"), false, "the identity module is not exported at all");
  assert.deepEqual(sorted(exported.get("./errors.js")), {
    values: ["ConcurrentReplacementError", "FilesystemIdentityAliasError", "InvalidInputError"],
    types: [],
  });
});

// ── N2: structural class shape ────────────────────────────────────────────────

test("N2: FilesystemBackend has a one-argument constructor, exactly the contract prototype, and no statics", () => {
  assert.equal(FilesystemBackend.length, 1);
  assert.deepEqual(Object.getOwnPropertyNames(FilesystemBackend.prototype).sort(), [
    "capabilities",
    "constructor",
    "delete",
    "deleteBlob",
    "exists",
    "existsBlob",
    "list",
    "listBlobs",
    "read",
    "readBlob",
    "readMany",
    "readReserved",
    "versions",
    "write",
    "writeBlob",
    "writeReserved",
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(FilesystemBackend).sort(), ["length", "name", "prototype"]);
  assert.deepEqual(Object.getOwnPropertySymbols(FilesystemBackend), []);
  assert.deepEqual(Object.getOwnPropertySymbols(FilesystemBackend.prototype), []);
  assert.equal(Object.getPrototypeOf(FilesystemBackend), Function.prototype, "no base class carries hidden members");
  const instance = new FilesystemBackend("/nonexistent");
  assert.deepEqual(Object.getOwnPropertyNames(instance), [], "state is private, not an own property");
});

test("N2: FilesystemMutationLockOptions has exactly waitMs, pollMs, portableRoot, lockRoot", async () => {
  const lock = await parse("filesystem-lock.ts");
  let members: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "FilesystemMutationLockOptions") {
      members = node.members.map((member) => (member.name && ts.isIdentifier(member.name) ? member.name.text : "?"));
    }
    ts.forEachChild(node, visit);
  };
  visit(lock);
  assert.deepEqual(members, ["waitMs", "pollMs", "portableRoot", "lockRoot"]);
});

// ── N4: import surface and environment isolation ──────────────────────────────

test("N4: only the identity and lock modules import node:fs, and the backend reaches neither fs, crypto, nor the lock", async () => {
  const files = (await readdir(SOURCE_ROOT)).filter((name) => /\.[cm]?ts$/.test(name)).sort();
  const fsImporters: string[] = [];
  for (const file of files) {
    const specifiers = importSpecifiers(await parse(file));
    if (specifiers.some((specifier) => FS_SPECIFIERS.has(specifier))) fsImporters.push(file);
  }
  assert.deepEqual(fsImporters, ["filesystem-identity.ts", "filesystem-lock.ts"]);

  const backend = importSpecifiers(await parse("backend.ts"));
  for (const banned of [...FS_SPECIFIERS, "node:crypto", "crypto", "./filesystem-lock.js"]) {
    assert.ok(!backend.includes(banned), `backend.ts must not import ${banned}`);
  }
  assert.ok(backend.includes("./filesystem-identity.js"), "the backend reaches the filesystem only through the identity port");
});

test("N4: the three runtime modules never read process.env", async () => {
  for (const file of IDENTITY_MODULES) {
    const source = await parse(file);
    assert.deepEqual(processEnvAccesses(source), [], `${file} references process.env`);
    assert.doesNotMatch(source.text, /process\s*\.\s*env|process\s*\[/, `${file} references process.env textually`);
    assert.doesNotMatch(source.text, /SUPERBEE_TEST_/, `${file} references a test-only environment name`);
  }
});

test("N4: only the lock module reads an ambient host input", async () => {
  const files = (await readdir(SOURCE_ROOT)).filter((name) => /\.[cm]?ts$/.test(name)).sort();
  const ambientImporters: string[] = [];
  for (const file of files) {
    if (ambientImports(await parse(file)).length > 0) ambientImporters.push(file);
  }
  // The lock module owns the runtime namespace and the owner record, so the temp directory, the
  // home directory, the user, and the host name are its inputs by design. Nothing else in the
  // engine may take one, and the two modules that decide identity least of all.
  //
  // Recorded reach and limits: the allowlist is engine-wide, not identity-specific, so a future
  // legitimate `node:os` use anywhere in `src` has to be added here deliberately. The scan
  // matches by imported name, so a local import that happens to be called `tmpdir`, `homedir`,
  // `hostname`, `userInfo`, or `networkInterfaces` would false-positive (none does today). It covers
  // imports only: `process.platform`, `process.getuid()`, `require("os")`, and a computed
  // dynamic specifier are outside it, and outside the sibling `process.env` guard as well.
  assert.deepEqual(ambientImporters, ["filesystem-lock.ts"]);
  for (const file of ["backend.ts", "filesystem-identity.ts"]) {
    assert.deepEqual(ambientImports(await parse(file)), [], `${file} imports an ambient host input; identity keys must stay pure`);
  }
});

// ── N4: the backend binds the one production port ─────────────────────────────

// `backend.ts` reaching the filesystem only through the identity module (asserted above) does not
// say WHICH port implementation it binds. A second port declared beside the production one and
// bound here keeps every import legal, typechecks, and passes every behavioral row in the
// repository, because the protocol rows pass their own port and the backend-driven rows cannot
// see the difference. So is a port derived locally at the call sites from the legally imported
// constant, which leaves the imports and the owning module untouched. The binding is therefore
// pinned structurally at four points: who may import the identity module at all, what the backend
// imports from it, what the owning module declares, and what each protocol call actually
// receives. The last of those fails closed twice over: the backend may reach a module only
// through a static import declaration, so there is one route to the identity module and no
// unresolvable specifier to argue about, and an entry point may be referenced only as the callee
// of its own call, because an aliased or forwarded binding puts the port argument beyond the
// reach of a static check.

test("N4: the identity module has exactly one importer in the package", async () => {
  const importers: string[] = [];
  const unfollowable: string[] = [];
  for (const file of await sourceModules()) {
    const source = await parse(file);
    const from = path.dirname(path.join(SOURCE_ROOT, file));
    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifierOf(node);
      if (specifier === null || (specifier !== undefined && !ts.isStringLiteralLike(specifier))) {
        unfollowable.push(`${file} names a module through a specifier that is not a string literal`);
      } else if (specifier !== undefined && MODULE_LOADER_SPECIFIERS.has(specifier.text)) {
        // A require function obtained here can be called under any name, so its call sites cannot
        // be found without dataflow. Naming the module at all is the route, and it fails closed.
        unfollowable.push(`${file} names '${specifier.text}', whose loader cannot be followed to its call sites`);
      } else if (specifier !== undefined && specifier.text.startsWith(".")) {
        // Resolved, so a different spelling of the same module is the same importer.
        if (path.resolve(from, specifier.text).replace(/\.js$/, "") === IDENTITY_MODULE_PATH && !importers.includes(file)) {
          importers.push(file);
        }
      }
      const factory = namesRequireFactory(node);
      if (factory !== undefined) unfollowable.push(`${file} names '${factory}', which yields a module loader`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(unfollowable, [], "a module route that cannot be followed statically could reach the identity module");
  // The rules below bound how backend.ts reaches the identity module and what it does with what
  // it gets. Neither can see a SECOND module that imports the identity module and hands an entry
  // point on under another name, as a namespace member, or as a default export: to the backend
  // that is an ordinary import of an ordinary module. There is no name-based defence against
  // that, so no such module may exist. Growing this list is therefore a deliberate act, and it
  // reopens the forwarding route for whatever is added.
  //
  // `import-direction.test.ts` independently bans the require family across this directory. This
  // row does not lean on it: a narrowing there must not silently cost the port guarantee its
  // backstop, so the require-style routes are recognized here too.
  assert.deepEqual(importers, ["backend.ts"], "only the backend may import the identity module; a second importer can forward its entry points");
});

test("N4: backend.ts imports exactly the protocol entry points and the one production port", async () => {
  const backend = await parse("backend.ts");
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === IDENTITY_MODULE
    ) {
      const clause = node.importClause;
      assert.ok(clause, "backend.ts must not import the identity module for its side effects");
      assert.equal(clause.name, undefined, "no default import");
      assert.ok(clause.namedBindings && ts.isNamedImports(clause.namedBindings), "a namespace import would reach every export");
      for (const element of clause.namedBindings.elements) {
        if (!clause.isTypeOnly && !element.isTypeOnly) values.push((element.propertyName ?? element.name).text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(backend);
  assert.deepEqual(values.sort(), ["mutateExact", "nodeFilesystemIdentityPort", "observeExact", "probeExact"]);
});

test("N4: the identity module declares exactly one FilesystemIdentityPort constant", async () => {
  const identity = await parse("filesystem-identity.ts");
  const ports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const annotation = node.type.typeName;
      if (ts.isIdentifier(annotation) && annotation.text === "FilesystemIdentityPort" && ts.isIdentifier(node.name)) {
        ports.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(identity);
  assert.deepEqual(ports, ["nodeFilesystemIdentityPort"], "a second port in the owning module is a binding the backend could take");
});

test("N4: every protocol call in backend.ts passes the imported production port", async () => {
  const backend = await parse("backend.ts");
  const protocolEntryPoints = new Set(["mutateExact", "observeExact", "probeExact"]);
  const line = (node: ts.Node): number => backend.getLineAndCharacterOfPosition(node.getStart(backend)).line + 1;

  // One route in. Every module reference that is not a static import declaration is rejected
  // wholesale -- a dynamic `import()` literal or computed, a `require`, an `import =`, a
  // re-export -- so no specifier has to be resolved to know whether it reaches the identity
  // module, and a computed one cannot hide behind the fact that it cannot be resolved.
  const otherRoutes: string[] = [];
  const identityImports: ts.ImportDeclaration[] = [];
  const protocolBindings = new Map<string, string>();
  let portBinding: string | undefined;
  const routes = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === IDENTITY_MODULE) identityImports.push(node);
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          // Local names, so an `as` alias on the port or on an entry point is followed, and the
          // entry points are recognized by their imported name whatever module supplies them.
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "nodeFilesystemIdentityPort" && specifier === IDENTITY_MODULE) portBinding = element.name.text;
          if (protocolEntryPoints.has(imported)) protocolBindings.set(element.name.text, specifier);
        }
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      otherRoutes.push(`a dynamic import() at line ${line(node)}`);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      otherRoutes.push(`a require() at line ${line(node)}`);
    } else if (ts.isImportEqualsDeclaration(node)) {
      otherRoutes.push(`an import = declaration at line ${line(node)}`);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      otherRoutes.push(`a re-export at line ${line(node)}`);
    }
    ts.forEachChild(node, routes);
  };
  routes(backend);

  assert.deepEqual(otherRoutes, [], "backend.ts must reach every module it uses through a static import declaration");
  assert.equal(identityImports.length, 1, "the identity module must be imported by exactly one declaration");
  assert.ok(portBinding, "backend.ts must import the production port");
  assert.deepEqual(
    [...protocolBindings].filter(([, specifier]) => specifier !== IDENTITY_MODULE),
    [],
    "a protocol entry point is bound from a module other than the identity module",
  );
  assert.equal(protocolBindings.size, protocolEntryPoints.size, "backend.ts must import every protocol entry point");

  const passed: string[] = [];
  const escaped: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && protocolBindings.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        const [port] = node.parent.arguments;
        passed.push(port && ts.isIdentifier(port) ? port.text : "a derived expression");
      } else {
        // Fail closed on every other reference shape rather than resolving arbitrary bindings:
        // once an entry point is aliased, assigned, or passed on, no static rule here can tell
        // which port the eventual call receives.
        escaped.push(`${node.text} in a ${ts.SyntaxKind[node.parent.kind]} at line ${line(node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(backend);

  assert.deepEqual(escaped, [], "a protocol entry point is referenced somewhere other than as the callee of its own call");
  // An exact count, not a floor: any change to the number of recognized call sites has to be a
  // deliberate edit here, so padding one in to replace a rerouted one is visible. It is a
  // tripwire and not a proof -- no count can show that every call site was recognized. That
  // rests on the route rules: this file reaches a module only by static import, and the identity
  // module has exactly one importer in the package, so there is no module that could hand an
  // entry point to the backend under a name this scan never sees.
  assert.equal(passed.length, 11, `expected the backend's protocol call sites, found ${passed.length}`);
  assert.deepEqual([...new Set(passed)], [portBinding], "a protocol call takes a port other than the imported production constant");
});

test("N4: the boundary scanner recognizes every ambient-input import form", () => {
  const source = ts.createSourceFile(
    "synthetic.ts",
    [
      'import { tmpdir } from "node:os";',
      'import * as os from "os";',
      'import { hostname as hn } from "./laundered.js";',
      'const later = import("node:os");',
      "void [tmpdir, os, hn, later];",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.deepEqual(ambientImports(source), ["hostname", "node:os", "os", "tmpdir"]);
});

test("N4: the boundary scanner recognizes every process.env access form", () => {
  const source = ts.createSourceFile(
    "synthetic.ts",
    ['const a = process.env.X;', 'const b = process["env"];', 'const { env } = process;', "void [a, b, env];"].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.deepEqual(processEnvAccesses(source), [1, 2, 3]);
});
