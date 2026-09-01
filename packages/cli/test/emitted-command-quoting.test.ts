import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { canonicalPath, scanEmittedCommandQuoting, toPosixPath } from "./support/emitted-command-scanner.js";

const SRC = join(import.meta.dirname, "../src");
const PROBES = join(import.meta.dirname, "fixtures/quoting-probes");
const TSCONFIG = join(import.meta.dirname, "../tsconfig.json");

/**
 * Files under `src` the scanner legitimately does not walk. Every entry must name WHY, so that
 * widening this list has to justify itself in a diff rather than happening as a side effect.
 */
const UNSCANNABLE: Record<string, string> = {
  "command-text.ts":
    "the rendering authority itself — it assembles tokens OUT OF raw values, which is the one place "
    + "an unrendered value is legitimate. Every other authority module (invocation.ts, "
    + "shell-quoting.ts) IS scanned and merely receives the brand-cast exemption.",
};

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return typeScriptFiles(path);
      return entry.name.endsWith(".ts") ? [toPosixPath(relative(SRC, path))] : [];
    })
    .sort();
}

test("every value interpolated into an emitted command passes through the quoting authority", () => {
  const { violations } = scanEmittedCommandQuoting(SRC, TSCONFIG);
  const report = violations
    .map((v) => `${v.file}:${v.line}  ${v.expression}\n    ${v.reason}\n    ${v.snippet}`)
    .join("\n");
  assert.equal(
    violations.length,
    0,
    `emitted-command quoting violations (see src/command-text.ts):\n${report}`,
  );
});

/**
 * COVERAGE CANARY.
 *
 * This class of failure is invisible by construction: a scanner that scans less still passes
 * everything it scans, so "no violations" and "no longer looking" produce identical output. An
 * authority check anchored on anything but file IDENTITY — a path relative to the scan root, or a
 * basename — silently removes files from the scan while everything still reports green. Noticing
 * that by re-reading a diff is not a repeatable control.
 *
 * So the scanned set is pinned against the real `src` listing. Adding a file to the skip list,
 * changing the file glob, or widening an "authority module" predicate fails HERE, with a diff of
 * exactly what stopped being scanned.
 */
test("the scanner still walks every source file it is supposed to walk", () => {
  const { scanned } = scanEmittedCommandQuoting(SRC, TSCONFIG);
  const expected = typeScriptFiles(SRC).filter((file) => !(file in UNSCANNABLE));

  const stoppedBeingScanned = expected.filter((file) => !scanned.includes(file));
  assert.deepEqual(
    stoppedBeingScanned,
    [],
    "these source files are no longer being scanned — coverage was lost silently:\n"
      + `${stoppedBeingScanned.join("\n")}\n`
      + "If a skip is intentional, add it to UNSCANNABLE with the reason.",
  );
  assert.deepEqual(
    scanned.filter((file) => !expected.includes(file)),
    [],
    "the scanner walked a file the canary did not expect",
  );
  // Non-empty and plausible, so a scan that silently found nothing at all cannot pass.
  assert.ok(scanned.length > 50, `implausibly few files scanned: ${scanned.length}`);
});

/**
 * The rule is only worth having if it still FAILS on the shapes it was built for, so the unsafe
 * shapes live in a fixture and are scanned deliberately. Every entry was a live defeat at some point
 * across three review rounds; none may silently come back.
 */
test("the rule catches each unsafe shape it was built for, and passes a correctly rendered one", () => {
  const { violations } = scanEmittedCommandQuoting(PROBES, TSCONFIG);
  const caught = new Map(violations.map((v) => [v.expression, v.reason]));

  const expected: [string, RegExp][] = [
    ["lit(bundleValue)", /commandLiteral\(\) requires a literal argument/],
    ["boundLiteral(bundleValue)", /commandLiteral\(\) requires a literal argument/],
    // Every spelling of the cast, decided by the asserted type's BRAND rather than its name.
    ["bundleValue as unknown as CommandText", /casting to CommandText outside the quoting authority/],
    ["bundleValue as unknown as CT", /casting to CommandText outside the quoting authority/],
    ["bundleValue as unknown as ct.CommandText", /casting to CommandText outside the quoting authority/],
    ["bundleValue as unknown as LocalAlias", /casting to CommandText outside the quoting authority/],
    ["commandToken(bundleValue)", /rendered token is wrapped in quotes again/],
    // `shellArg` throws on Windows rather than degrading, so only the authority may call it.
    ["shellArg(bundleValue)", /shellArg\(\) outside the quoting authority throws on Windows/],
  ];
  for (const [expression, reason] of expected) {
    assert.match(caught.get(expression) ?? "", reason, `${expression} must be reported`);
  }

  const reasons = violations.filter((v) => v.expression === "bundleValue").map((v) => v.reason);
  for (const shape of [/concatenated into/, /joined into/, /unquoted value in an argument position/]) {
    assert.ok(reasons.some((r) => shape.test(r)), `no violation matched ${shape}: ${reasons.join(" | ")}`);
  }

  // The re-wrap guard must see across a `+` as well as inside one template.
  assert.equal(
    violations.filter((v) => /wrapped in quotes again/.test(v.reason)).length,
    2,
    "both re-wrap shapes must be caught",
  );

  // A file whose BASENAME collides with an authority module, at a nested path, is NOT the authority:
  // it must be scanned like any other consumer and its cast must be rejected. Keying authority on a
  // basename made these two invisible while everything reported green.
  for (const file of ["nested/command-text.ts", "nested/invocation.ts"]) {
    assert.ok(
      violations.some((v) => v.file === file),
      `${file} collides with an authority basename and must NOT inherit authority status.\n`
        + `Reported files were: ${JSON.stringify([...new Set(violations.map((v) => v.file))])}.\n`
        + "If the expected path appears there with different SEPARATORS, this is a path-normalization "
        + "bug in the test harness, NOT a file inheriting authority status.",
    );
  }

  // A FOREIGN module sharing the authority's renderer name must not inherit its whole-argument
  // exemption — the value inside it is unrendered and must still be reported.
  assert.ok(
    violations.some((v) => v.file === "probes.ts" && v.expression === "bundleValue"
      && /argument position/.test(v.reason)),
    "a foreign renderer must not launder an unrendered value",
  );
  // ...and the other direction: a foreign function merely NAMED `commandLiteral` must not be held
  // to the authority's literal-only contract.
  assert.ok(
    !violations.some((v) => /foreignLiteral/.test(v.expression)),
    `an unrelated function sharing a name must not be flagged: ${JSON.stringify(violations.map((v) => v.expression))}`,
  );

  // Every probe in the fixture, and nothing else.
  assert.equal(violations.length, 17, violations.map((v) => `${v.file}:${v.line} ${v.reason}`).join("\n"));
});
