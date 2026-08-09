import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { scanArityArchitecture, type ArchitectureFacts } from "./support/arity-architecture-scanner.js";

const SRC = join(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function scanProduction(): ArchitectureFacts {
  const combined: ArchitectureFacts = { directParseArgs: [], parseDecisions: [], selectorCalls: [], deferFactoryCalls: [] };
  for (const path of sourceFiles(SRC)) {
    const facts = scanArityArchitecture(relative(SRC, path), readFileSync(path, "utf8"));
    combined.directParseArgs.push(...facts.directParseArgs);
    combined.parseDecisions.push(...facts.parseDecisions);
    combined.selectorCalls.push(...facts.selectorCalls);
    combined.deferFactoryCalls.push(...facts.deferFactoryCalls);
  }
  return combined;
}

function labels(rows: Array<{ file: string; functionName: string }>): string[] {
  return rows.map((row) => `${row.file}:${row.functionName}`).sort();
}

test("production parser calls and actual decisions satisfy the closed AST/import-aware allowlists", () => {
  const facts = scanProduction();
  assert.deepEqual(labels(facts.directParseArgs), [
    "cli.ts:hoistLeadingGlobalFlags",
    "cli.ts:isGlobalOnlyHomeInvocation",
    "commands/home.ts:parseHomeArgs",
  ]);

  assert.deepEqual(
    facts.parseDecisions.filter((row) => row.decision.kind === "invalid"),
    [],
    "every parseOrUsage call must pass an owning leafArity/deferArity factory call",
  );
  assert.deepEqual(
    facts.parseDecisions
      .filter((row) => row.decision.kind === "deferred")
      .map((row) => `${row.file}:${row.functionName}:${row.decision.value}`)
      .sort(),
    [
      "args.ts:parseSelectorOrUsage:<nonliteral>",
      "commands/doc/update.ts:parseDocUpdateArgs:doc-update:token-normalization",
      "commands/new.ts:newCommand:new:schema",
    ],
  );
  assert.deepEqual(
    facts.deferFactoryCalls.map((row) => `${row.file}:${row.functionName}:${row.reason}`).sort(),
    [
      "args.ts:parseSelectorOrUsage:<nonliteral>",
      "commands/doc/update.ts:parseDocUpdateArgs:doc-update:token-normalization",
      "commands/new.ts:newCommand:new:schema",
    ],
  );
  assert.deepEqual(
    facts.selectorCalls.map((row) => `${row.file}:${row.functionName}:${row.reason}`).sort(),
    [
      "commands/bundle.ts:bundleCommand:selector:bundle",
      "commands/catalog.ts:catalogInner:selector:catalog",
      "commands/hook.ts:hook:selector:hook",
      "commands/index.ts:indexCommand:selector:index",
      "commands/kind.ts:kind:selector:kind",
      "commands/skill.ts:skill:selector:skill",
      "commands/view.ts:view:selector:view",
    ],
  );
});

test("shared scanner recognizes namespace and aliased parser/helper/factory calls", () => {
  const namespaceBypass = scanArityArchitecture("commands/probe.ts", `
    import * as util from "node:util";
    import * as arity from "../args.js";
    export function bare(argv: string[]) { return util.parseArgs({ args: argv, options: {} }); }
    export function forged(argv: string[]) {
      return arity.parseOrUsage(
        () => util.parseArgs({ args: argv, options: {}, allowPositionals: true }),
        "list",
        { kind: "deferred", reason: "new:schema" },
      );
    }
  `);
  assert.deepEqual(labels(namespaceBypass.directParseArgs), ["commands/probe.ts:bare"]);
  assert.deepEqual(namespaceBypass.parseDecisions.map((row) => row.decision.kind), ["invalid"]);

  const defaultAndForeign = scanArityArchitecture("commands/foreign.ts", `
    import util from "util";
    import * as foreign from "foreign/args.js";
    export function defaultBare(argv: string[]) {
      return foreign.parseOrUsage(
        () => util.parseArgs({ args: argv, options: {}, allowPositionals: true }),
        "list", foreign.leafArity("list"),
      );
    }
  `);
  assert.deepEqual(labels(defaultAndForeign.directParseArgs), ["commands/foreign.ts:defaultBare"]);
  assert.deepEqual(defaultAndForeign.parseDecisions, []);

  const namespaceJoined = scanArityArchitecture("commands/joined.ts", `
    import * as util from "node:util";
    import * as arity from "../args.js";
    export function joined(argv: string[]) {
      return arity.parseOrUsage(
        () => util.parseArgs({ args: argv, options: {}, allowPositionals: true }),
        "list",
        arity.leafArity("list"),
      );
    }
    export function selected(argv: string[]) {
      return arity.parseSelectorOrUsage(
        () => util.parseArgs({ args: argv, options: {}, allowPositionals: true }),
        "view", "selector:view", () => ({ kind: "navigation" }),
      );
    }
  `);
  assert.deepEqual(namespaceJoined.directParseArgs, []);
  assert.deepEqual(namespaceJoined.parseDecisions.map((row) => row.decision), [{ kind: "leaf", value: "list" }]);
  assert.deepEqual(namespaceJoined.selectorCalls.map((row) => row.reason), ["selector:view"]);

  const aliased = scanArityArchitecture("commands/aliased.ts", `
    import { parseArgs as parseNode } from "node:util";
    import { parseOrUsage as parseOwned, deferArity as approvedDeferral } from "../args.js";
    export function normalized(argv: string[]) {
      return parseOwned(
        () => parseNode({ args: argv, options: {}, allowPositionals: true }),
        "doc update", approvedDeferral("doc-update:token-normalization"),
      );
    }
  `);
  assert.deepEqual(aliased.directParseArgs, []);
  assert.deepEqual(aliased.parseDecisions.map((row) => row.decision), [
    { kind: "deferred", value: "doc-update:token-normalization" },
  ]);
  assert.deepEqual(aliased.deferFactoryCalls.map((row) => row.reason), ["doc-update:token-normalization"]);
});
