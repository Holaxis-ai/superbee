import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { CLI_LEAVES } from "../src/command-spec.js";
import { scanArityArchitecture, type ArchitectureFacts } from "./support/arity-architecture-scanner.js";

const SRC = join(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function scanProduction(): ArchitectureFacts {
  const combined: ArchitectureFacts = {
    directParseArgs: [], ownedCalls: [], directArityAssertions: [], runAxiCliCalls: [], violations: [],
  };
  for (const path of sourceFiles(SRC)) {
    const facts = scanArityArchitecture(relative(SRC, path), readFileSync(path, "utf8"));
    combined.directParseArgs.push(...facts.directParseArgs);
    combined.ownedCalls.push(...facts.ownedCalls);
    combined.directArityAssertions.push(...facts.directArityAssertions);
    combined.runAxiCliCalls.push(...facts.runAxiCliCalls);
    combined.violations.push(...facts.violations);
  }
  return combined;
}

function labels(rows: Array<{ file: string; functionName: string }>): string[] {
  return rows.map((row) => `${row.file}:${row.functionName}`).sort();
}

test("production parser and SDK authorities satisfy the closed import-aware architecture", () => {
  const facts = scanProduction();
  assert.deepEqual(facts.violations, []);
  assert.deepEqual(labels(facts.directParseArgs), [
    "cli.ts:hoistLeadingGlobalFlags",
    "cli.ts:isGlobalOnlyHomeInvocation",
    "commands/home.ts:parseHomeArgs",
  ]);
  assert.deepEqual(labels(facts.ownedCalls.filter((row) => row.api === "parseSelectorOrUsage")), [
    "commands/bundle.ts:bundleCommand",
    "commands/catalog.ts:catalogInner",
    "commands/hook.ts:hook",
    "commands/index.ts:indexCommand",
    "commands/kind.ts:kind",
    "commands/skill.ts:skill",
    "commands/view.ts:view",
  ]);
  assert.deepEqual(labels(facts.ownedCalls.filter((row) => row.api === "parseNewSchemaPhaseOrUsage")), [
    "commands/new.ts:newCommand",
  ]);
  assert.deepEqual(labels(facts.ownedCalls.filter((row) => row.api === "parseDocUpdateTokensOrUsage")), [
    "commands/doc/update.ts:parseDocUpdateArgs",
  ]);
  assert.deepEqual(labels(facts.directArityAssertions), [
    "args.ts:parseLeafOrUsage",
    "args.ts:parseSelectorOrUsage",
    "commands/doc/update.ts:docUpdate",
  ]);
  assert.deepEqual(facts.runAxiCliCalls, [{ file: "cli.ts", functionName: "main", commands: "RUNTIME_COMMANDS" }]);

  const ordinaryLeaves = facts.ownedCalls
    .filter((row) => row.api === "parseLeafOrUsage")
    .map((row) => row.leaf);
  assert.equal(ordinaryLeaves.filter((leaf) => leaf === "HOME_LEAF").length, 1);
  const publicOrdinaryIds = ordinaryLeaves.filter((leaf) => leaf !== "HOME_LEAF").map((leaf) => {
    const matched = /^CLI_LEAVES\.([A-Za-z0-9]+)$/.exec(leaf);
    assert.ok(matched, `ordinary parser must receive a direct canonical member: ${leaf}`);
    const id = matched[1]!;
    assert.equal(Object.hasOwn(CLI_LEAVES, id), true, `ordinary parser names unknown leaf id: ${id}`);
    return id;
  });
  assert.equal(new Set(publicOrdinaryIds).size, publicOrdinaryIds.length, "ordinary leaves must not be duplicated or substituted");
});

test("scanner rejects local aliases, namespace destructuring, storage, and computed access", () => {
  const cases = [
    `import { parseArgs } from "node:util"; const p = parseArgs; p({});`,
    `import * as util from "node:util"; const { parseArgs: p } = util; p({});`,
    `import { parseLeafOrUsage } from "../args.js"; const helpers = { parseLeafOrUsage };`,
    `import { parseNewSchemaPhaseOrUsage } from "../args.js"; function keep(x: unknown) { return x; } keep(parseNewSchemaPhaseOrUsage);`,
    `import { parseDocUpdateTokensOrUsage } from "../args.js"; function escape() { return parseDocUpdateTokensOrUsage; }`,
    `import * as util from "node:util"; util["parseArgs"]({});`,
  ];
  for (const [index, source] of cases.entries()) {
    const facts = scanArityArchitecture(`commands/escape-${index}.ts`, source);
    assert.notEqual(facts.violations.length, 0, source);
  }
});

test("scanner rejects direct/owned re-exports and non-static module access", () => {
  const direct = scanArityArchitecture("commands/re-export.ts", `
    export { parseArgs } from "node:util";
    export { parseLeafOrUsage } from "../args.js";
    export * from "axi-sdk-js";
  `);
  assert.equal(direct.violations.length, 3);

  const importedThenExported = scanArityArchitecture("commands/export-alias.ts", `
    import { parseArgs as nodeParser } from "node:util";
    import { parseLeafOrUsage as ownedParser } from "../args.js";
    export { nodeParser as parseEscape, ownedParser as ownedEscape };
  `);
  assert.equal(importedThenExported.violations.length >= 2, true);

  const dynamic = scanArityArchitecture("commands/dynamic.ts", `
    import util = require("node:util");
    async function a() { await import("../args.js"); }
    function b() { return require("axi-sdk-js"); }
  `);
  assert.ok(dynamic.violations.length >= 3);
});

test("scanner exposes a namespace-qualified raw parser bypass to the closed site allowlist", () => {
  const facts = scanArityArchitecture("commands/qualified.ts", `
    import * as util from "node:util";
    export function bypass(argv: string[]) { return util.parseArgs({ args: argv, options: {} }); }
  `);
  assert.deepEqual(labels(facts.directParseArgs), ["commands/qualified.ts:bypass"]);
  assert.deepEqual(facts.violations, []);
});

test("scanner requires canonical ordinary leaves and the exact runtime registry expression", () => {
  const facts = scanArityArchitecture("commands/probe.ts", `
    import { parseArgs } from "node:util";
    import { parseLeafOrUsage } from "../args.js";
    import { runAxiCli } from "axi-sdk-js";
    export function probe(argv: string[], leaf: unknown) {
      parseLeafOrUsage(() => parseArgs({ args: argv, options: {} }), leaf as never);
      return runAxiCli({ commands: { probe: async () => "" } } as never);
    }
  `);
  assert.deepEqual(facts.directParseArgs, []);
  assert.equal(facts.violations.some((row) => /canonical leaf/.test(row.reason)), true);
  assert.equal(facts.violations.some((row) => /RUNTIME_COMMANDS/.test(row.reason)), true);
});
