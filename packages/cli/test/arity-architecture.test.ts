import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { CLI_LEAVES } from "../src/command-spec.js";
import {
  BEHAVIOR_ASSIGNMENTS,
  BEHAVIOR_DIMENSION_VALUES,
  BUILT_KEY_REPRESENTATIVE_IDS,
  BUILT_REPRESENTATIVE_IDS,
  BUILT_REVIEW_SENTINEL_IDS,
  assignmentIndex,
  behaviorKey,
  validateBehaviorCoverage,
  type BehaviorAssignment,
  type BehaviorDimension,
  type BehaviorDimensions,
} from "./arity-equivalence-matrix.js";
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

  const classified = assignmentIndex();
  const mappedOrdinaryIds = [...new Set([...classified]
    .filter(([, row]) => row.dimensions.parserAuthority === "ordinary")
    .map(([id]) => CLI_LEAVES[id].canonical.id))]
    .sort();
  assert.deepEqual(publicOrdinaryIds.filter((id) => id !== "new").sort(), mappedOrdinaryIds);
  assert.deepEqual(
    [...classified]
      .filter(([, row]) => row.dimensions.parserAuthority === "selector")
      .map(([id]) => id)
      .sort(),
    [
      "bundleLocate", "catalogAdd", "catalogList", "catalogResolve", "hookInstall", "hookStatus",
      "hookUninstall", "indexGenerate", "kindFieldAdd", "kindFieldRemove", "skillInstall",
      "skillStatus", "skillUninstall", "viewList",
    ],
  );
  assert.deepEqual(
    [...classified]
      .filter(([, row]) => row.dimensions.parserAuthority === "schema-deferred")
      .map(([id]) => id),
    ["new"],
  );
  assert.deepEqual(
    [...classified]
      .filter(([, row]) => row.dimensions.parserAuthority === "dynamic-deferred")
      .map(([id]) => id),
    ["docUpdate"],
  );
});

test("behavioral-equivalence taxonomy is exhaustive, coherent, and materially smaller", () => {
  const leafIds = Object.keys(CLI_LEAVES);
  assert.deepEqual(validateBehaviorCoverage(leafIds, BEHAVIOR_ASSIGNMENTS, BUILT_KEY_REPRESENTATIVE_IDS), []);
  assert.deepEqual(BUILT_REVIEW_SENTINEL_IDS, ["skillStatus", "kindFieldRemove", "blobs", "pull"]);
  assert.equal(
    new Set(BUILT_REPRESENTATIVE_IDS).size,
    BUILT_KEY_REPRESENTATIVE_IDS.length + BUILT_REVIEW_SENTINEL_IDS.length,
    "key owners and review sentinels must be unique and disjoint",
  );
  assert.equal(BUILT_REPRESENTATIVE_IDS.length < leafIds.length / 2, true, "built rows must remain materially smaller than the leaf catalog");

  const assignments = assignmentIndex();
  assert.deepEqual([...assignments.keys()].sort(), leafIds.sort());
  for (const [leafId, assignment] of assignments) {
    const leaf = CLI_LEAVES[leafId];
    const dimensions = assignment.dimensions;
    assert.equal(dimensions.positionalCount, leaf.arity.count, `${leaf.path}: positional count`);
    assert.equal(
      dimensions.canonicalIdentity,
      leaf.canonical === leaf ? "canonical" : "alias",
      `${leaf.path}: canonical alias identity`,
    );
    assert.equal(dimensions.selectorLayout === "none", dimensions.parserAuthority !== "selector", `${leaf.path}: selector layout`);

    if (dimensions.parserAuthority === "schema-deferred") {
      assert.equal(dimensions.helpPrecedence, "schema-before-arity", leaf.path);
      assert.equal(dimensions.terminatorPrecedence, "schema-reparse-before-arity", leaf.path);
      assert.equal(dimensions.preValidationEffect, "schema-bundle-read", leaf.path);
    } else if (dimensions.parserAuthority === "dynamic-deferred") {
      assert.equal(dimensions.helpPrecedence, "token-walk-before-arity", leaf.path);
      assert.equal(dimensions.terminatorPrecedence, "token-walk-before-arity", leaf.path);
      assert.equal(dimensions.preValidationEffect, "none", leaf.path);
    } else {
      assert.equal(dimensions.helpPrecedence, "owned-before-arity", leaf.path);
      assert.equal(dimensions.terminatorPrecedence, "parseargs-before-arity", leaf.path);
      assert.equal(dimensions.preValidationEffect, "none", leaf.path);
    }
  }
});

test("every key dimension creates an uncovered class until a built representative is added", () => {
  const leafIds = Object.keys(CLI_LEAVES);
  const coveredKeys = new Set(BEHAVIOR_ASSIGNMENTS.map((row) => behaviorKey(row.dimensions)));

  for (const dimension of Object.keys(BEHAVIOR_DIMENSION_VALUES) as BehaviorDimension[]) {
    let novel: BehaviorDimensions | undefined;
    for (const assignment of BEHAVIOR_ASSIGNMENTS) {
      const candidates = BEHAVIOR_DIMENSION_VALUES[dimension] as readonly BehaviorDimensions[typeof dimension][];
      for (const candidate of candidates) {
        if (candidate === assignment.dimensions[dimension]) continue;
        const dimensions = { ...assignment.dimensions, [dimension]: candidate } as BehaviorDimensions;
        if (!coveredKeys.has(behaviorKey(dimensions))) {
          novel = dimensions;
          break;
        }
      }
      if (novel) break;
    }
    assert.ok(novel, `${dimension}: test fixture needs a novel value combination`);
    const synthetic = `synthetic-${dimension}`;
    const assignments: readonly BehaviorAssignment<string>[] = [
      ...BEHAVIOR_ASSIGNMENTS,
      { leafId: synthetic, dimensions: novel },
    ];
    assert.equal(
      validateBehaviorCoverage([...leafIds, synthetic], assignments, BUILT_KEY_REPRESENTATIVE_IDS)
        .some((message) => message.startsWith("behavioral-equivalence key has no built representative:")),
      true,
      `${dimension}: a new key must fail closed without a representative`,
    );
  }
});

test("coverage validator rejects unmapped and multiply mapped leaves", () => {
  const leafIds = Object.keys(CLI_LEAVES);
  const missing = BEHAVIOR_ASSIGNMENTS.filter((row) => row.leafId !== "setup");
  assert.equal(validateBehaviorCoverage(leafIds, missing, BUILT_KEY_REPRESENTATIVE_IDS).includes("leaf has no behavioral-equivalence key: setup"), true);

  const duplicated = [...BEHAVIOR_ASSIGNMENTS, BEHAVIOR_ASSIGNMENTS[0]!];
  assert.equal(
    validateBehaviorCoverage(leafIds, duplicated, BUILT_KEY_REPRESENTATIVE_IDS)
      .includes("leaf has 2 behavioral-equivalence keys: bundleLocate"),
    true,
  );
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
