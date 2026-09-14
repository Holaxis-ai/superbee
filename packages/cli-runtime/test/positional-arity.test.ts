import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "node:util";

import { parseLeafOrUsage } from "../src/args.js";
import { CLI_LEAVES, HOME_LEAF, PUBLIC_LEAVES, exactPositionalArity } from "../src/command-spec.js";
import { CliError } from "../src/errors.js";
import { assertLeafArity } from "../src/positional-arity.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { serve } from "../src/commands/serve.js";

test("exact arity accepts its boundary without mutating input", () => {
  for (const leaf of [CLI_LEAVES.list, CLI_LEAVES.docWrite, CLI_LEAVES.linkAdd]) {
    const values = Array.from({ length: leaf.arity.count }, (_, index) => `arg-${index}`);
    const before = [...values];
    assertLeafArity(leaf, values);
    assert.deepEqual(values, before);
  }
});

test("exact arity rejects low/high counts as typed bounded USAGE", () => {
  for (const [leaf, values] of [
    [CLI_LEAVES.docWrite, []],
    [CLI_LEAVES.docWrite, ["a", "b"]],
    [CLI_LEAVES.linkAdd, ["a"]],
  ] as const) {
    assert.throws(() => assertLeafArity(leaf, values), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "USAGE");
      assert.match(error.message, /expected/);
      return true;
    });
  }
  const huge = "x".repeat(100_000);
  let rendered = "";
  try { assertLeafArity(CLI_LEAVES.list, [huge]); } catch (error) {
    assert.ok(error instanceof CliError);
    rendered = JSON.stringify({ message: error.message, details: error.details, help: error.help });
  }
  assert.ok(Buffer.byteLength(rendered) < 2_000);
  assert.match(rendered, /…/);
});

test("exact count factory rejects invalid counts", () => {
  for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => exactPositionalArity(value), /non-negative safe integer/);
  }
});

test("reference paths and canonical leaves are exhaustive and aliases share identity", () => {
  const paths = COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((command) => command.paths));
  assert.equal(paths.length, PUBLIC_LEAVES.length);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual([...new Set(paths)].sort(), PUBLIC_LEAVES.map((leaf) => leaf.path).sort());
  assert.strictEqual(CLI_LEAVES.query.arity, CLI_LEAVES.list.arity);
  assert.strictEqual(CLI_LEAVES.query.canonical, CLI_LEAVES.list);
  assert.equal(HOME_LEAF.exposure, "hidden");
});

test("owned parser handles options, help precedence, and the -- terminator", () => {
  const options = { limit: { type: "string" }, help: { type: "boolean", short: "h" } } as const;
  assert.doesNotThrow(() => parseLeafOrUsage(
    () => parseArgs({ args: ["--limit", "1"], options, allowPositionals: true }),
    CLI_LEAVES.list,
  ));
  assert.doesNotThrow(() => parseLeafOrUsage(
    () => parseArgs({ args: ["extra", "--help"], options, allowPositionals: true }),
    CLI_LEAVES.list,
  ));
  assert.throws(() => parseLeafOrUsage(
    () => parseArgs({ args: ["--", "--help"], options, allowPositionals: true }),
    CLI_LEAVES.list,
  ), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  assert.throws(() => parseLeafOrUsage(
    () => parseArgs({ args: ["-1"], options, allowPositionals: true }),
    CLI_LEAVES.list,
  ), (error: unknown) => error instanceof CliError && error.code === "USAGE");
});

test("owned parser rejects forged leaves before invoking the parser", () => {
  let parserCalls = 0;
  assert.throws(() => parseLeafOrUsage(
    () => {
      parserCalls++;
      return parseArgs({ args: [], options: {}, allowPositionals: true });
    },
    { path: "list", arity: { kind: "exact", count: 0 } } as never,
  ), /invalid CLI leaf/i);
  assert.equal(parserCalls, 0);

  const copiedBrand = { ...CLI_LEAVES.list };
  assert.throws(() => parseLeafOrUsage(
    () => {
      parserCalls++;
      return parseArgs({ args: [], options: {}, allowPositionals: true });
    },
    copiedBrand,
  ), /invalid CLI leaf/i);
  assert.equal(parserCalls, 0);
});

test("built init rejects surplus before creating its target", () => {
  const root = mkdtempSync(join(tmpdir(), "aslite-arity-red-"));
  const target = join(root, "bundle");
  const result = spawnSync(process.execPath, ["packages/cli/dist/superbee.mjs", "init", "unexpected", "--dir", target, "--recipe", "none"], { cwd: join(import.meta.dirname, "../../.."), encoding: "utf8" });
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
