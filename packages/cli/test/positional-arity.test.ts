import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "node:util";

import { leafArity, parseOrUsage } from "../src/args.js";
import { CliError } from "../src/errors.js";
import {
  LEAF_POSITIONAL_ARITY,
  LEAF_ARITY_VALIDATION_PHASE,
  assertLeafArity,
  exact,
  minimum,
  range,
  variadic,
} from "../src/positional-arity.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { serve } from "../src/commands/serve.js";

test("arity primitive accepts every supported contract shape and never mutates input", () => {
  const cases = [
    [exact(0), []],
    [exact(1), ["a"]],
    [exact(2), ["a", "b"]],
    [minimum(1), ["a"]],
    [minimum(1), ["a", "b", "c"]],
    [range(1, 3), ["a"]],
    [range(1, 3), ["a", "b"]],
    [range(1, 3), ["a", "b", "c"]],
    [variadic(1, "item"), ["a"]],
    [variadic(1, "item"), ["a", "b", "c", "d"]],
  ] as const;
  for (const [contract, values] of cases) {
    const before = [...values];
    assertLeafArity("doc write", values, contract);
    assert.deepEqual(values, before);
  }
});

test("arity primitive rejects low/high counts as typed bounded USAGE", () => {
  for (const [contract, values] of [[exact(1), []], [exact(1), ["a", "b"]], [minimum(2), ["a"]], [range(1, 2), []], [range(1, 2), ["a", "b", "c"]], [variadic(2, "item"), ["a"]]] as const) {
    assert.throws(() => assertLeafArity("doc write", values, contract), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "USAGE");
      assert.match(error.message, /expected|requires|takes/);
      return true;
    });
  }
  const huge = "x".repeat(100_000);
  let rendered = "";
  try { assertLeafArity("list", [huge]); } catch (error) {
    assert.ok(error instanceof CliError);
    rendered = JSON.stringify({ message: error.message, details: error.details, help: error.help });
  }
  assert.ok(Buffer.byteLength(rendered) < 2_000);
  assert.match(rendered, /…/);
});

test("reference paths and canonical arity are exhaustive and aliases share identity", () => {
  const paths = COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((command) => command.paths));
  assert.equal(paths.length, 41);
  assert.deepEqual([...new Set(paths)].sort(), Object.keys(LEAF_POSITIONAL_ARITY).filter((path) => path !== "home").sort());
  assert.strictEqual(LEAF_POSITIONAL_ARITY.query, LEAF_POSITIONAL_ARITY.list);
  assert.equal(LEAF_POSITIONAL_ARITY.home.kind, "exact");
  assert.deepEqual(Object.keys(LEAF_ARITY_VALIDATION_PHASE), ["new"]);
});

test("parser classification owns options, help precedence, and the -- terminator", () => {
  const options = { limit: { type: "string" }, help: { type: "boolean", short: "h" } } as const;
  assert.doesNotThrow(() => parseOrUsage(
    () => parseArgs({ args: ["--limit", "1"], options, allowPositionals: true }),
    "list",
    leafArity("list"),
  ));
  assert.doesNotThrow(() => parseOrUsage(
    () => parseArgs({ args: ["extra", "--help"], options, allowPositionals: true }),
    "list",
    leafArity("list"),
  ));
  assert.throws(() => parseOrUsage(
    () => parseArgs({ args: ["--", "--help"], options, allowPositionals: true }),
    "list",
    leafArity("list"),
  ), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  assert.throws(() => parseOrUsage(
    () => parseArgs({ args: ["-1"], options, allowPositionals: true }),
    "list",
    leafArity("list"),
  ), (error: unknown) => error instanceof CliError && error.code === "USAGE");
});

test("parseOrUsage rejects forged decisions before invoking the parser", () => {
  let parserCalls = 0;
  assert.throws(() => parseOrUsage(
    () => {
      parserCalls++;
      return parseArgs({ args: [], options: {}, allowPositionals: true });
    },
    "list",
    { kind: "deferred", reason: "new:schema" } as never,
  ), /invalid arity decision/i);
  assert.equal(parserCalls, 0);
});

test("built init rejects surplus before creating its target", () => {
  const root = mkdtempSync(join(tmpdir(), "aslite-arity-red-"));
  const target = join(root, "bundle");
  const result = spawnSync(process.execPath, ["packages/cli/dist/agentstate-lite.mjs", "init", "unexpected", "--dir", target, "--recipe", "none"], { cwd: join(import.meta.dirname, "../../.."), encoding: "utf8" });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /USAGE/);
  assert.throws(() => readFileSync(join(target, "index.md")));
});

test("serve surplus rejects before the injected listener authority is called", async () => {
  let bootCalls = 0;
  await assert.rejects(
    () => serve(["extra"], {
      stdout: () => undefined,
      bootServer: async () => {
        bootCalls++;
        throw new Error("boot must be unreachable");
      },
      waitForShutdown: async () => undefined,
    }),
    (error: unknown) => error instanceof CliError && error.code === "USAGE",
  );
  assert.equal(bootCalls, 0);
});
