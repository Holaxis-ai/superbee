import assert from "node:assert/strict";
import test from "node:test";
import { findingsFor, type MappingDiagnostic } from "../src/connectors.js";
import { maskMarkdownCode } from "../src/links.js";

// Measure production code before mutation instrumentation adds coverage probes to its loops.
test("maskMarkdownCode stays linear on hostile backtick runs", () => {
  let hostile = "";
  for (let run = 1; run < 2000; run++) hostile += "`".repeat(run) + "x";
  const started = performance.now();
  maskMarkdownCode(hostile.repeat(4));
  assert.ok(performance.now() - started < 2000, "masking hostile backtick runs should be linear");
});

test("findingsFor stays linear across 80,000 records", () => {
  const diagnostics: MappingDiagnostic[] = [];
  for (let i = 0; i < 80_000; i++) diagnostics.push({ code: "VALUE_UNMAPPED", field: "event_status", from: "status", native: "WITHDRAWN", external_id: `evt-${i}` });
  diagnostics.push({ ...diagnostics[0]! });
  const started = performance.now();
  const findings = findingsFor(diagnostics, { source: "events" });
  assert.ok(performance.now() - started < 2000, "mapping findings should remain linear");
  assert.equal(findings.length, 1);
});
