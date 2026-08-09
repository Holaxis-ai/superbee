/**
 * `parseOrUsage` / `translateParseArgsError` — the single chokepoint that translates node
 * `parseArgs`'s raw dependency-wording errors into clean, tool-native USAGE messages (AXI §6),
 * grounded in real `parseArgs` throws (not guessed error codes).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { leafArity, parseOrUsage as parseOrUsageWithArity } from "../src/args.js";
import { CliError } from "../src/errors.js";

function parseOrUsage<T extends { positionals: readonly string[]; values?: object }>(parse: () => T, command: string): T {
  return parseOrUsageWithArity(parse, command, leafArity("list"));
}

function assertUsage(err: unknown, message: string, command = "list"): void {
  assert.ok(err instanceof CliError, "expected a CliError");
  const cli = err as CliError;
  assert.equal(cli.code, "USAGE");
  assert.equal(cli.exitCode, 2);
  assert.equal(cli.message, message);
  assert.ok(cli.help?.endsWith(`${command} --help`), `help should point at '${command} --help', got: ${cli.help}`);
}

test("A2.a unknown long option -> clean message, no advisory tail", () => {
  assert.throws(
    () =>
      parseOrUsage(
        () => parseArgs({ args: ["--foo"], options: {}, allowPositionals: true }),
        "list",
      ),
    (err: unknown) => {
      assertUsage(err, "unknown option '--foo'");
      assert.ok(!(err as CliError).message.includes("To specify a positional argument"));
      return true;
    },
  );
});

test("A2.b unknown short option", () => {
  assert.throws(
    () => parseOrUsage(() => parseArgs({ args: ["-x"], options: {}, allowPositionals: true }), "list"),
    (err: unknown) => {
      assertUsage(err, "unknown option '-x'");
      return true;
    },
  );
});

test("A2.c missing option value", () => {
  assert.throws(
    () =>
      parseOrUsage(
        () =>
          parseArgs({
            args: ["--type"],
            options: { type: { type: "string" } },
            allowPositionals: true,
          }),
        "list",
      ),
    (err: unknown) => {
      assertUsage(err, "option '--type' requires a value");
      return true;
    },
  );
});

test("A2.d boolean option given a value ('does not take an argument')", () => {
  assert.throws(
    () =>
      parseOrUsage(
        () =>
          parseArgs({
            args: ["--json=hi"],
            options: { json: { type: "boolean" } },
            allowPositionals: true,
          }),
        "list",
      ),
    (err: unknown) => {
      assertUsage(err, "option '--json' takes no value");
      return true;
    },
  );
});

test("A2.e unexpected positional (positionals disallowed)", () => {
  assert.throws(
    () => parseOrUsage(() => parseArgs({ args: ["bar"], options: {}, allowPositionals: false }), "whoami"),
    (err: unknown) => {
      assertUsage(err, "unexpected argument 'bar'", "whoami");
      return true;
    },
  );
});

test("A2.f ambiguous option value ('argument is ambiguous')", () => {
  assert.throws(
    () =>
      parseOrUsage(
        () =>
          parseArgs({
            args: ["--type", "--json"],
            options: { type: { type: "string" }, json: { type: "boolean" } },
            allowPositionals: true,
          }),
        "list",
      ),
    (err: unknown) => {
      assertUsage(err, "option '--type' requires a value");
      return true;
    },
  );
});

test("A2.g unrecognized ERR_PARSE_ARGS_* code falls back to a trimmed original, never a worse generic", () => {
  const synthetic = Object.assign(new Error("Some future parse failure. To specify a positional argument x"), {
    code: "ERR_PARSE_ARGS_FUTURE",
  });
  assert.throws(
    () =>
      parseOrUsage(() => {
        throw synthetic;
      }, "list"),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      const cli = err as CliError;
      assert.equal(cli.code, "USAGE");
      assert.equal(cli.exitCode, 2);
      assert.equal(cli.message, "Some future parse failure");
      return true;
    },
  );
});

test("A2.h CliError passthrough: never remapped to USAGE", () => {
  assert.throws(
    () =>
      parseOrUsage(() => {
        throw new CliError("NOT_FOUND", "no such bundle");
      }, "list"),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      const cli = err as CliError;
      assert.equal(cli.code, "NOT_FOUND");
      assert.equal(cli.exitCode, 6);
      assert.equal(cli.message, "no such bundle");
      return true;
    },
  );
});

test("A2.i non-Error throw -> String(err), exit 2 (regression guard)", () => {
  assert.throws(
    () =>
      parseOrUsage(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "boom";
      }, "list"),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      const cli = err as CliError;
      assert.equal(cli.code, "USAGE");
      assert.equal(cli.exitCode, 2);
      assert.equal(cli.message, "boom");
      return true;
    },
  );
});

test("A2.j code-less Error with an already-clean message passes through via stripAdvisory unchanged", () => {
  assert.throws(
    () =>
      parseOrUsage(() => {
        throw new Error("already clean, no advisory tail here");
      }, "list"),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      const cli = err as CliError;
      assert.equal(cli.code, "USAGE");
      assert.equal(cli.message, "already clean, no advisory tail here");
      return true;
    },
  );
});
