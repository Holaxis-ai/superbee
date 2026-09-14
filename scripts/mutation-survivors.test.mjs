import test from "node:test";
import assert from "node:assert/strict";

import { survivorsFromReport } from "./mutation-survivors.mjs";

const SOURCE = ["export function f(a, b) {", "  return a + b;", "}"].join("\n");

function report(mutants) {
  return { files: { "src/f.ts": { source: SOURCE, mutants } } };
}

const loc = (line, startCol, endCol) => ({
  start: { line, column: startCol },
  end: { line, column: endCol },
});

test("survivorsFromReport: killed and timeout mutants count as detected, never listed", () => {
  const { rows, summary } = survivorsFromReport(
    report([
      { status: "Killed", mutatorName: "ArithmeticOperator", replacement: "-", location: loc(2, 12, 17) },
      { status: "Timeout", mutatorName: "BlockStatement", replacement: "{}", location: loc(1, 25, 26) },
    ]),
    "packages/core",
  );
  assert.equal(rows.length, 0);
  assert.deepEqual(summary, {
    label: "packages/core",
    total: 2,
    detected: 2,
    survived: 0,
    noCoverage: 0,
    score: 100,
  });
});

test("survivorsFromReport: survived + no-coverage mutants become rows with the mutated source slice", () => {
  const { rows, summary } = survivorsFromReport(
    report([
      { status: "Survived", mutatorName: "ArithmeticOperator", replacement: "a - b", location: loc(2, 10, 15) },
      { status: "NoCoverage", mutatorName: "BlockStatement", replacement: "{}", location: loc(1, 25, 26) },
      { status: "Killed", mutatorName: "EqualityOperator", replacement: "!==", location: loc(2, 12, 14) },
    ]),
    "packages/cli",
  );
  assert.equal(rows.length, 2);
  const survived = rows.find((r) => r.status === "Survived");
  assert.equal(survived.file, "packages/cli/src/f.ts");
  assert.equal(survived.line, 2);
  assert.equal(survived.original, "a + b");
  assert.equal(survived.replacement, "a - b");
  assert.equal(summary.total, 3);
  assert.equal(summary.detected, 1);
  assert.equal(summary.survived, 1);
  assert.equal(summary.noCoverage, 1);
  // Mutation score per the mutation-testing-report-schema: detected / total valid mutants.
  assert.ok(Math.abs(summary.score - 100 / 3) < 1e-9);
});

test("survivorsFromReport: rows sort by file then line; empty report yields null score", () => {
  const twoFiles = {
    files: {
      "src/b.ts": { source: SOURCE, mutants: [{ status: "Survived", mutatorName: "M", replacement: "x", location: loc(3, 1, 2) }] },
      "src/a.ts": {
        source: SOURCE,
        mutants: [
          { status: "Survived", mutatorName: "M", replacement: "x", location: loc(2, 1, 2) },
          { status: "Survived", mutatorName: "M", replacement: "x", location: loc(1, 1, 2) },
        ],
      },
    },
  };
  const { rows } = survivorsFromReport(twoFiles, "p");
  assert.deepEqual(
    rows.map((r) => `${r.file}:${r.line}`),
    ["p/src/a.ts:1", "p/src/a.ts:2", "p/src/b.ts:3"],
  );

  const empty = survivorsFromReport({ files: {} }, "p");
  assert.equal(empty.summary.score, null);
  assert.equal(empty.rows.length, 0);
});
